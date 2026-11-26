import { appendFile, readFile } from 'node:fs/promises';
import { claimJob, prComment, reportJob, runScan, upsertPrComment } from './scan.mjs';

const input = (name, fallback = '') => process.env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] ?? process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
const escapeCommand = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const event = process.env.GITHUB_EVENT_NAME ?? '';
const isPullRequest = event.startsWith('pull_request');
let job = null, options = null;
try {
    const key = input('api-key');
    if (key) process.stdout.write(`::add-mask::${escapeCommand(key)}\n`);
    const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8').catch(() => '{}')) : {};
    const defaultBranch = payload.repository?.default_branch ?? null;
    const branch = isPullRequest ? (process.env.GITHUB_HEAD_REF || null) : (process.env.GITHUB_REF_NAME || null);
    const onDefault = !isPullRequest && !!branch && branch === defaultBranch;
    options = {
        apiKey: key, apiUrl: input('api-url', 'https://orbu--orbu-agents-2026.europe-west4.hosted.app'),
        project: input('project') || process.env.GITHUB_REPOSITORY || '', path: input('path', '.'), baselinePath: input('baseline-path'),
        locale: input('locale', 'en'), usageContext: input('usage-context', 'business'), analyzer: input('analyzer', 'static'),
        store: input('store', 'false') === 'true', includeTests: input('include-tests', 'false') === 'true',
        failOn: input('fail-on', 'none'), riskThreshold: input('risk-threshold', '80'),
        isPullRequest, tempDir: process.env.RUNNER_TEMP,
        repository: process.env.GITHUB_REPOSITORY ?? '', workflow: process.env.GITHUB_WORKFLOW ?? null, defaultBranch,
        source: { branch, defaultBranch: onDefault, commit: process.env.GITHUB_SHA ?? null, trigger: isPullRequest ? 'pull_request' : event === 'push' ? 'push' : event === 'schedule' ? 'schedule' : 'manual' },
    };
    // Jobs are taken only from the default branch, so a requested scan always reflects production code.
    const jobs = input('jobs', 'true') === 'true' && onDefault && options.repository;
    const claimed = jobs ? await claimJob(options) : { available: false, job: null };
    job = claimed.job;
    if (job) Object.assign(options, { store: true, jobId: job.id, mode: job.mode, source: { ...options.source, trigger: 'job' } });
    if (event === 'schedule' && !job) {
        process.stdout.write('Orbu: no evaluation requested. Nothing to scan.\n');
    } else {
        const scan = await runScan(options);
        // The first stored scan creates the project; connect this repository right after it.
        if (jobs && !claimed.available && scan.result.stored) await claimJob(options, false).catch(() => null);
        if (job) await reportJob(options, job.id, { status: 'succeeded', result: { agents: scan.result.agents.length, stored: !!scan.result.stored, skipped: scan.result.skipped?.length ?? 0, inventoryReconciled: !!scan.result.inventoryReconciled, commit: options.source.commit, branch: options.source.branch, engineVersion: scan.result.analysis?.revision ?? null } });
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `report-path=${scan.output}\nagents=${scan.result.agents.length}\npolicy-failed=${scan.failed}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, scan.summary);
        // On pull requests, one comment that Orbu keeps up to date. A missing permission never fails the review.
        const number = payload.pull_request?.number, token = input('github-token');
        if (isPullRequest && number && token && input('comment', 'true') === 'true') {
            const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${options.repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
            const body = prComment(scan.result, scan.changes, { locale: options.locale, failed: scan.failed, policy: options.failOn, reportUrl: runUrl });
            await upsertPrComment({ token, repository: options.repository, number, body, apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com' })
                .catch(error => process.stdout.write(`::warning::Orbu could not comment on the pull request (${escapeCommand(error.message)}). Give the workflow pull-requests: write.\n`));
        }
        process.stdout.write(`Orbu: ${scan.result.agents.length} configurations. Reports saved in ${scan.output}\n`);
        if (scan.failed) { process.stdout.write('::error::The Orbu review policy requires attention. Open the scan report.\n'); process.exitCode = 1; }
    }
} catch (error) {
    // Never log upstream payloads, source code or credentials.
    const message = error instanceof Error ? error.message : 'Orbu scan failed';
    if (job && options) await reportJob(options, job.id, { status: 'failed', error: message.slice(0, 300) }).catch(() => null);
    process.stdout.write(`::error::${escapeCommand(message)}\n`);
    process.exitCode = 1;
}
