---
name: backend-showrunner
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  refreshToken: $LINEAR_REFRESH_TOKEN
  clientId: $LINEAR_CLIENT_ID
  clientSecret: $LINEAR_CLIENT_SECRET
  teamKey: NEU
  activeStates: ["Todo", "In Progress"]
  terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"]
  assignee: "me"
  labels: ["target:maestro-be-showrunner", "route:auto"]
workspace:
  rootDir: ${MAESTRO_DATA_DIR}/backend-showrunner
  repo:
    url: https://github.com/NeukoAI/showrunner-agents.git
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
- Your cwd is already a fresh clone of `showrunner-agents` (the Hermes Agent codebase, Python) on `dev`. **Do not `cd`** — bash commands are stateless and `cd` won't persist between invocations.

## Repo conventions

Before writing code, read `AGENTS.md` and `CONTRIBUTING.md` at the repo root. Key points:

- **Activate the venv first.** `source venv/bin/activate` — required before any Python invocation. If the venv doesn't exist, follow CONTRIBUTING.md to create it (`uv venv venv --python 3.11 && uv pip install -e ".[all,dev]"`).
- **Tests:** `pytest tests/ -v`. Run before pushing.
- **Lint:** project doesn't enforce a single linter in CI; match existing file style (`black`-ish, type hints where surrounding code uses them).
- **Schema migrations live in `hermes_state.py`** — not Alembic. Bump `SCHEMA_VERSION` and add a migration block following the precedent at `hermes_state.py:607` (the `v11` block). Migrations must be idempotent and additive.
- **Cron job storage is a JSON file** (`cron/jobs.py`), not a DB. Treat the on-disk job record shape as a stable contract — additive fields only.
- **The web API lives in `hermes_cli/web_server.py`** behind a session-token + `x-api-key` auth middleware. New `/api/*` routes inherit that auth automatically.
- **Commit format:** `<type>(<scope>): <description>` (e.g. `feat(cron): add cron_runs table`). Prefix the FIRST commit with `{{ issue.identifier }}:` for traceability.

## Workflow

Run these three skills in order, with backend implementation work in between:

1. **`Skill(skill="gitStart")`** — detects an existing PR for this ticket, walks every reviewer/bot comment into a punch list, and sets up the working branch (re-run checkout or `feat/{{ issue.identifier | downcase }}-<slug>` first-pass).

2. **Implement the change.** Hermes-specific best practices:
   - **Schema changes:** bump `SCHEMA_VERSION` in `hermes_state.py`; add a versioned migration block. Never edit historical migration blocks. Migrations run on agent boot, so they must tolerate already-applied state.
   - **New endpoints:** add to `hermes_cli/web_server.py`. Follow the existing `@app.get/.post` patterns. Use `HTTPException(status_code=…)` for errors. New `/api/*` routes are automatically gated by the session-token middleware — don't add a separate auth layer.
   - **Path traversal:** any endpoint that reads files by user-supplied path/timestamp must resolve the path and verify it stays under the expected root (compare `Path(...).resolve()` against `EXPECTED_ROOT.resolve()`). See `tools/file_tools.py` for the established sanitization pattern.
   - **Tests:** add or update tests under `tests/` for every new endpoint, schema migration, or `cron/*` function. Match the existing fixture style in `tests/hermes_cli/` and `tests/cron/`. Run `pytest tests/ -v` before moving on.
   - **Backward compatibility:** API consumers (the agent-dashboard, the TUI, the gateway) treat unknown fields as no-ops. New response fields are safe; renaming or removing fields is not — flag in the PR body.
   - **Concurrency:** the cron scheduler uses a file lock (`cron/scheduler.py` `tick()`). Anything that touches `cron/jobs.py` `save_jobs()` must respect `_jobs_file_lock`.
   - As you finish each verifiable acceptance criterion in the description, call **`Skill(skill="acceptanceSync")`** to flip the corresponding `- [ ]` to `- [x]`. You may call this multiple times.
   - On a re-run, address every item from the `gitStart` punch list — bot or human reviewer feedback, failing checks, all of it.

3. **`Skill(skill="gitFinish", args="reviewer: deusexmachina892")`** — commit with `{{ issue.identifier }}: <…>` messages, push, open or update the PR against `dev`, request review from `@deusexmachina892`, and post the PR link as a Linear comment on UUID `{{ issue.id }}`. End your response with the PR URL on its own line.

## Hard rules

- Do all work on the ticket branch — never push to `dev` directly.
- One ticket = one PR.
- Never edit a previously-applied schema migration block in `hermes_state.py`. New version, new block.
- Never modify production-only config (secrets, API keys, OAuth client IDs) without explicit ticket authorization.
- Never bypass the session-token middleware for new `/api/*` routes.
- If reviewer feedback is ambiguous or contradicts the ticket, leave a `gh pr comment` asking for clarification rather than guessing.
- Never check an acceptance-criteria box you did not actually implement and verify.
