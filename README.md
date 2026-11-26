# Orbu agent review

Find the AI agents in your repository, score their risk from 0 to 10 and get a review on every pull request.
Source code never leaves the runner: the action analyses it locally and sends Orbu only paths, lines,
function names and the kind of operation found (payments, emails, data access, model calls).

- **Inventory**: every agent and tool it can call, with what it can do and how risky that is.
- **Pull request review**: one comment, kept up to date, with what the change does to your agents.
- **Policy**: fail the check on high risk or on any regression, if you want to.
- **Reports**: JSON, Markdown and HTML attached to every run.

Reads JavaScript, TypeScript and Python in depth, and Go, Java, Kotlin, Swift, Dart, C#, PHP, Ruby and Rust.

## Quick start

1. Create a free account at [orbu](https://orbu--orbu-agents-2026.europe-west4.hosted.app/account) and an API key in Guides, API keys.
2. Save it as the `ORBU_API_KEY` repository secret.
3. Copy [`examples/orbu-agents.yml`](examples/orbu-agents.yml) to `.github/workflows/` and pin this action to a full commit SHA.

```yaml
- uses: actions/checkout@v6
  with:
    persist-credentials: false
    path: head
- uses: juancarlosmnavas/orbu-agent-review@FULL_COMMIT_SHA
  with:
    api-key: ${{ secrets.ORBU_API_KEY }}
    path: head
```

Pushes to the default branch update your Orbu inventory. Pull requests compare against their base and never change it.
Forks do not receive your secrets, so the example skips pull requests from forks. Never switch it to `pull_request_target`.

## Permissions

`contents: read` to read the code. `pull-requests: write` only if you want the review comment.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `api-key` (required) | Orbu API key. Keep it in GitHub Actions secrets. |  |
| `api-url` | Orbu service origin. | `https://orbu--orbu-agents-2026.europe-west4.hosted.app` |
| `path` | Repository directory to scan. No project code is executed. | `.` |
| `baseline-path` | Optional checkout of the PR base for a direct before/after comparison. |  |
| `project` | Stable project slug. Defaults to owner.repository. |  |
| `locale` | Report language, en or es. | `en` |
| `usage-context` | business, provider or personal. | `business` |
| `analyzer` | auto, static or llm. llm requires a configured Orbu server model. | `static` |
| `store` | Save the canonical inventory. Always disabled for pull requests. | `false` |
| `include-tests` | Include test and evaluation entry points. | `false` |
| `fail-on` | none, high-risk or regression. Errors always fail. | `none` |
| `jobs` | Take discovery and re-evaluation jobs requested from Orbu. Needs a credential bound to this project. Only on the default branch. | `true` |
| `comment` | On pull requests, leave one comment with what the change does to the agents, kept up to date. Needs pull-requests write permission. | `true` |
| `github-token` | Token used to write the pull request comment. |  |
| `risk-threshold` | Integer from 1 to 100 for high-risk policy. | `80` |

## Outputs

| Output | Description |
| --- | --- |
| `report-path` | Directory containing JSON, Markdown, HTML and the change summary. |
| `agents` | Number of detected configurations. |
| `policy-failed` | Whether the selected risk policy failed. |

## Privacy

No code is uploaded and no project code is executed. Orbu receives metadata only, described in its privacy policy.

## License

Orbu's Action and evaluator are offered under the [MIT License](LICENSE). Third-party components keep their respective licenses, listed in `agent-evaluator.mjs.LEGAL.txt` and `agent-evaluator-LICENSE.txt`. This license applies to this distribution, not to Orbu's server or the rest of its private application.
