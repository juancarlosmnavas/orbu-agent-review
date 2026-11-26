import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateProject } from './agent-evaluator.mjs';
import labels from './labels.json' with { type: 'json' };

const slug = value => String(value).replaceAll('/', '.').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 80);
const choices = (value, allowed, name) => { if (!allowed.includes(value)) throw new Error(`Invalid ${name}`); return value; };
const md = value => String(value).replace(/[\r\n|<>]/g, ' ').replace(/[`[\]*#]/g, '');
// Validate before *every* authenticated request, including the job lookup before the scan.
const apiOrigin = value => {
    const origin = new URL(value);
    if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('api-url must be an HTTPS origin (HTTP is allowed only for localhost)');
    return origin;
};

export function compareScans(before, after) {
    const previous = new Map(before.agents.map(agent => [agent.key, agent]));
    const current = new Set(after.agents.map(agent => agent.key));
    return {
        added: after.agents.filter(agent => !previous.has(agent.key)).map(agent => ({ key: agent.key, name: agent.name })),
        removed: before.agents.filter(agent => !current.has(agent.key)).map(agent => ({ key: agent.key, name: agent.name })),
        changed: after.agents.flatMap(agent => {
            const old = previous.get(agent.key); if (!old) return [];
            const addedPermissions = agent.profile.permissions.filter(permission => !old.profile.permissions.includes(permission));
            const removedPermissions = old.profile.permissions.filter(permission => !agent.profile.permissions.includes(permission));
            const removedControls = old.profile.controls.filter(control => !agent.profile.controls.includes(control));
            const addedTriggers = (agent.traits?.triggers ?? []).filter(trigger => !(old.traits?.triggers ?? []).includes(trigger));
            const candidates = record => [...new Set((record.evidence ?? []).filter(evidence => evidence.note?.startsWith('control_candidate:')).map(evidence => evidence.ref))];
            const currentCandidates = candidates(agent), oldCandidates = candidates(old);
            const removedControlCandidates = oldCandidates.filter(candidate => !currentCandidates.includes(candidate));
            const delta = agent.risk.overall - old.risk.overall;
            const previousFindings = new Set((old.codeEvaluation?.findings ?? []).map(finding => finding.code));
            const addedFindings = [...new Set((agent.codeEvaluation?.findings ?? []).filter(finding => finding.priority === 'HIGH' && !previousFindings.has(finding.code)).map(finding => finding.code))];
            return addedPermissions.length || removedPermissions.length || removedControls.length || addedTriggers.length || removedControlCandidates.length || addedFindings.length || delta ? [{ key: agent.key, name: agent.name, addedPermissions, removedPermissions, removedControls, addedTriggers, removedControlCandidates, addedFindings, riskBefore: old.risk.overall, riskAfter: agent.risk.overall }] : [];
        }),
    };
}

export function policyFails(result, changes, policy, threshold) {
    if (policy === 'high-risk') return result.agents.some(agent => agent.risk.overall >= threshold);
    if (policy === 'regression') return !!(changes?.added.length || changes?.changed.some(agent => agent.riskAfter > agent.riskBefore || agent.addedPermissions.length || agent.removedControls.length || agent.removedControlCandidates.length || agent.addedFindings.length || agent.addedTriggers.some(trigger => ['event', 'schedule', 'queue'].includes(trigger))));
    return false;
}

export const COMMENT_MARKER = '<!-- orbu-agent-review -->';
/**
 * The pull request comment: what this change does to the agents, in plain words. Scores out of 10, permission and
 * control names instead of ids, and nothing when nothing changes but a short "no changes" line.
 */
export function prComment(result, changes, { locale = 'en', failed = false, policy = 'none', reportUrl = null } = {}) {
    const es = locale === 'es', L = (a, b) => es ? a : b;
    const ten = n => (n / 10).toLocaleString(es ? 'es-ES' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const perm = id => md(labels.permissions[id]?.[locale] ?? id), ctrl = id => md(labels.controls[id]?.[locale] ?? id);
    const byKey = new Map(result.agents.map(a => [a.key, a]));
    const rows = [];
    for (const a of changes?.added ?? []) {
        const agent = byKey.get(a.key);
        rows.push(`| **${md(a.name)}** | ${L('Nuevo', 'New')} | ${agent ? ten(agent.risk.overall) : '–'} | ${agent?.profile.permissions.length ? L('Puede: ', 'Can: ') + agent.profile.permissions.map(perm).join(', ') : '–'} |`);
    }
    for (const c of changes?.changed ?? []) {
        const what = [
            ...c.addedPermissions.map(p => L(`Ahora puede: ${perm(p)}`, `Can now: ${perm(p)}`)),
            ...c.removedPermissions.map(p => L(`Ya no puede: ${perm(p)}`, `No longer: ${perm(p)}`)),
            ...c.removedControls.map(x => L(`Pierde el control: ${ctrl(x)}`, `Loses control: ${ctrl(x)}`)),
            ...(c.addedTriggers ?? []).map(t => L(`Nuevo disparador: ${md(t)}`, `New trigger: ${md(t)}`)),
            ...(c.addedFindings?.length ? [L(`${c.addedFindings.length} hallazgo(s) graves nuevos`, `${c.addedFindings.length} new high finding(s)`)] : []),
        ];
        const delta = c.riskAfter - c.riskBefore;
        rows.push(`| **${md(c.name)}** | ${ten(c.riskBefore)} → ${ten(c.riskAfter)}${delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : ''} | ${ten(c.riskAfter)} | ${what.join('<br>') || '–'} |`);
    }
    for (const r of changes?.removed ?? []) rows.push(`| ${md(r.name)} | ${L('Ya no aparece', 'No longer found')} | – | – |`);
    const head = !changes ? L('Evaluación de los agentes de esta rama.', 'Evaluation of this branch’s agents.')
        : rows.length ? L(`Este cambio afecta a ${rows.length} ${rows.length === 1 ? 'agente' : 'agentes'}.`, `This change affects ${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}.`)
        : L('Este cambio no modifica lo que pueden hacer tus agentes.', 'This change does not alter what your agents can do.');
    const verdict = policy === 'none' ? '' : failed ? L('**Requiere revisión** según la política del repositorio.', '**Needs review** under the repository policy.') : L('Cumple la política del repositorio.', 'Meets the repository policy.');
    return [
        COMMENT_MARKER, `### Orbu`, '', head + (verdict ? ` ${verdict}` : ''), '',
        ...(rows.length ? [`| ${L('Agente', 'Agent')} | ${L('Nota antes → después', 'Score before → after')} | ${L('Nota', 'Score')} | ${L('Qué cambia', 'What changes')} |`, '|---|---|---|---|', ...rows, ''] : []),
        `${L('Agentes en esta rama', 'Agents in this branch')}: ${result.agents.length}. ${L('Nota de 0 a 10: más alta, más riesgo.', 'Scores from 0 to 10: higher means more risk.')}${reportUrl ? ` [${L('Informe completo', 'Full report')}](${reportUrl})` : ''}`,
        '', `<sub>${L('Analizado en el runner, sin enviar código a Orbu.', 'Analysed on the runner; no source code is sent to Orbu.')}</sub>`,
    ].join('\n');
}

/** Creates the review comment on the pull request, or updates the one Orbu left before. */
export async function upsertPrComment({ token, repository, number, body, apiUrl = 'https://api.github.com' }, fetchImpl = fetch) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
    const base = `${apiUrl}/repos/${repository}/issues/${number}/comments`;
    let previous = null;
    for (let page = 1; page <= 5 && !previous; page++) {
        const res = await fetchImpl(`${base}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} while reading comments`);
        const list = await res.json();
        previous = list.find(c => typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER)) ?? null;
        if (list.length < 100) break;
    }
    const res = await fetchImpl(previous ? `${apiUrl}/repos/${repository}/issues/comments/${previous.id}` : base, { method: previous ? 'PATCH' : 'POST', headers, body: JSON.stringify({ body }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} while writing the review comment`);
    return previous ? 'updated' : 'created';
}

/** Shared by the GitHub Action and CLI. No shell commands, dependency installs or project imports. */
export async function runScan(options, fetchImpl = fetch) {
    const origin = apiOrigin(options.apiUrl);
    if (!options.apiKey) throw new Error('Set the Orbu API key secret before running the scan');
    const project = slug(options.project);
    if (!project) throw new Error('Set a stable project name');
    const locale = choices(options.locale ?? 'en', ['en', 'es'], 'locale');
    const usageContext = choices(options.usageContext ?? 'business', ['business', 'provider', 'personal'], 'usage-context');
    const analyzer = choices(options.analyzer ?? 'auto', ['auto', 'static', 'llm'], 'analyzer');
    const failOn = choices(options.failOn ?? 'none', ['none', 'high-risk', 'regression'], 'fail-on');
    const threshold = Number(options.riskThreshold ?? 80);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error('risk-threshold must be an integer from 1 to 100');
    if (failOn === 'regression' && !options.baselinePath) throw new Error('The regression policy requires baseline-path');
    async function submit(path, store) {
        const metadata = evaluateProject(resolve(path), { includeTests: !!options.includeTests });
        // source tells Orbu which branch and commit were analysed; non-default branches never change the stored inventory.
        const source = { branch: options.source?.branch ?? null, defaultBranch: options.source?.defaultBranch ?? !options.isPullRequest, commit: options.source?.commit ?? null, trigger: options.source?.trigger ?? 'manual', jobId: options.jobId ?? null };
        const body = JSON.stringify({ project: { name: project }, locale, usageContext, analyzer, includeTests: !!options.includeTests, store, mode: options.mode ?? 'full', source: store ? source : { ...source, defaultBranch: false }, prescan: metadata });
        if (Buffer.byteLength(body) > 1_048_576) throw new Error('Scan metadata exceeds 1 MiB. Split the project into independently named scans');
        const response = await fetchImpl(new URL('/api/v1/scans/auto', origin), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, body,
        });
        if (!response.ok) throw new Error(`Orbu API returned HTTP ${response.status}. Check the key, rate limit and analyzer configuration`);
        const result = await response.json();
        if (!Array.isArray(result.agents) || typeof result.report?.content !== 'string' || typeof result.report?.htmlContent !== 'string') throw new Error('Orbu returned an invalid scan response');
        return result;
    }
    // PR and baseline scans never update the main inventory, including when store=true was supplied.
    const baseline = options.baselinePath ? await submit(options.baselinePath, false) : null;
    const result = await submit(options.path ?? '.', options.store === true && !options.isPullRequest);
    const changes = baseline ? compareScans(baseline, result) : null;
    const failed = policyFails(result, changes, failOn, threshold);
    // The run summary and the PR comment say the same thing.
    const summary = prComment(result, changes, { locale, failed, policy: failOn }).replace(`${COMMENT_MARKER}\n`, '');
    // A new private directory prevents reports from following repository-controlled symlinks.
    const output = await mkdtemp(join(options.tempDir ?? tmpdir(), 'orbu-scan-'));
    await Promise.all([
        writeFile(join(output, 'report.md'), result.report.content, { mode: 0o600 }),
        writeFile(join(output, 'report.html'), result.report.htmlContent, { mode: 0o600 }),
        writeFile(join(output, 'scan.json'), JSON.stringify(result, null, 2), { mode: 0o600 }),
        writeFile(join(output, 'changes.json'), JSON.stringify(changes, null, 2), { mode: 0o600 }),
        writeFile(join(output, 'summary.md'), summary, { mode: 0o600 }),
    ]);
    return { result, changes, failed, output, summary };
}

/**
 * Continuous evaluation. The Action connects its repository to the Orbu project and takes the oldest job
 * requested from the web, API or MCP. Requires a credential bound to this project; other keys skip jobs.
 */
export async function claimJob(options, take = true, fetchImpl = fetch) {
    const response = await fetchImpl(new URL('/api/v1/projects/claim-job', apiOrigin(options.apiUrl)), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: slug(options.project), repository: options.repository, workflow: options.workflow ?? null, defaultBranch: options.defaultBranch ?? null, take }),
    });
    if (response.status === 404 || response.status === 403) return { available: false, job: null, status: response.status };
    if (!response.ok) throw new Error(`Orbu API returned HTTP ${response.status} while checking for evaluation jobs`);
    const body = await response.json();
    return { available: true, job: body.job ?? null, status: response.status };
}
export async function reportJob(options, jobId, outcome, fetchImpl = fetch) {
    const response = await fetchImpl(new URL(`/api/v1/projects/jobs/${encodeURIComponent(jobId)}`, apiOrigin(options.apiUrl)), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(outcome),
    });
    if (!response.ok) throw new Error(`Orbu API returned HTTP ${response.status} while reporting job ${jobId}`);
}
