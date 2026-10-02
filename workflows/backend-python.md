---
name: backend-python
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  refreshToken: $LINEAR_REFRESH_TOKEN
  clientId: $LINEAR_CLIENT_ID
  clientSecret: $LINEAR_CLIENT_SECRET
  teamKey: ENG
  activeStates: ["Todo", "In Progress"]
  terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"]
  assignee: "me"
  labels: ["target:maestro-be-python", "route:auto"]
workspace:
  rootDir: ${MAESTRO_DATA_DIR}/backend-python
  repo:
    url: https://github.com/your-org/your-repo.git
    branch: dev
polling:
  intervalMs: 15000
agent:
  maxConcurrent: 2
  maxTurns: 150
  completionState: "In Review"
  inProgressState: "In Progress"
backend: open-agent
backendOptions:
  apiType: openai-completions
  baseURL: https://api.concentrate.ai/v1
  apiKey: $CONCENTRATE_API_KEY
  model: anthropic/claude-sonnet-4-6
  permissionMode: bypassPermissions
---

Solve this issue: **{{ issue.identifier }}** — {{ issue.title }}

{{ issue.description }}

## Ticket context (for skill calls)

- Ticket id: `{{ issue.identifier }}`
- Linear issue UUID: `{{ issue.id }}`
- Issue URL: {{ issue.url }}
- Base branch: `dev`
- Your cwd is already a fresh clone of the target repo (a Python service) on `dev`. **Do not `cd`** — bash commands are stateless and `cd` won't persist between invocations.

## Repo conventions

Before writing code, read `AGENTS.md` and `CONTRIBUTING.md` at the repo root if they exist. Key points:

- **Activate the venv first.** `source venv/bin/activate` — required before any Python invocation. If the venv doesn't exist, follow CONTRIBUTING.md to create it (e.g. `uv venv venv --python 3.11 && uv pip install -e ".[dev]"`).
- **Tests:** `pytest tests/ -v`. Run before pushing.
- **Lint:** match the existing file style (formatter, type hints where surrounding code uses them).
- **Commit format:** `<type>(<scope>): <description>` (e.g. `feat(api): add runs endpoint`). Prefix the FIRST commit with `{{ issue.identifier }}:` for traceability.

## Workflow

Run these three skills in order, with backend implementation work in between:

1. **`Skill(skill="gitStart")`** — detects an existing PR for this ticket, walks every reviewer/bot comment into a punch list, and sets up the working branch (re-run checkout or `feat/{{ issue.identifier | downcase }}-<slug>` first-pass).

2. **Implement the change.** Python-service best practices:
   - **Schema changes:** add a new, versioned migration. Never edit a migration that has already been applied. Migrations must be idempotent and additive unless the ticket explicitly authorizes a destructive change.
   - **New endpoints:** follow the existing routing and error-handling patterns. New routes must go through the existing auth middleware — don't add a parallel auth layer.
   - **Path traversal:** any endpoint that reads files by a user-supplied path must resolve the path and verify it stays under the expected root (compare `Path(...).resolve()` against `EXPECTED_ROOT.resolve()`).
   - **Tests:** add or update tests under `tests/` for every new endpoint, migration, or service function. Match the existing fixture style. Run `pytest tests/ -v` before moving on.
   - **Backward compatibility:** new response fields are safe; renaming or removing fields is not — flag it in the PR body.
   - As you finish each verifiable acceptance criterion in the description, call **`Skill(skill="acceptanceSync")`** to flip the corresponding `- [ ]` to `- [x]`. You may call this multiple times.
   - On a re-run, address every item from the `gitStart` punch list — bot or human reviewer feedback, failing checks, all of it.

3. **`Skill(skill="gitFinish", args="reviewer: your-reviewer")`** — commit with `{{ issue.identifier }}: <…>` messages, push, open or update the PR against `dev`, request review from `@your-reviewer`, and post the PR link as a Linear comment on UUID `{{ issue.id }}`. End your response with the PR URL on its own line.

## Hard rules

- Do all work on the ticket branch — never push to `dev` directly.
- One ticket = one PR.
- Never edit a previously-applied migration. New version, new migration.
- Never modify production-only config (secrets, API keys, OAuth client IDs) without explicit ticket authorization.
- Never bypass the auth middleware for new routes.
- If reviewer feedback is ambiguous or contradicts the ticket, leave a `gh pr comment` asking for clarification rather than guessing.
- Never check an acceptance-criteria box you did not actually implement and verify.
