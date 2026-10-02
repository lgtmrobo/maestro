# Contributing to Maestro

Guide for working on Maestro. The full reference is [README.md](./README.md); this doc covers **how it's built, how to deploy it, and what to watch out for**.

---

## What Maestro is, in one paragraph

A long-running Node daemon that polls a ticket tracker (Linear today; GitHub Issues / GitLab adapters are stubbed), and for each ticket dispatches a coding agent in an isolated workspace. The agent reads the repo, makes changes, commits, pushes a branch, opens a PR via `gh`, and posts a link back to the tracker. Tickets auto-move to a configured "done-ish" state on success. Multiple **workflows** (= lanes) run in one daemon, each with their own tracker filter, target repo, and agent backend.

```
Linear ticket  →  Maestro lane polls every 15s
                       │
                       └─→ dispatch agent run
                              │
                              ├─→ fresh git clone of target repo
                              ├─→ agent loop (Claude or any OpenAI-compat model)
                              ├─→ commit / push / gh pr create
                              └─→ Linear ticket → "In Review" + PR-link comment
```

## Architecture at a glance

```
src/
├── orchestrator.ts        Multi-lane coordinator. Spawns one Lane per workflow file.
├── lane.ts                Per-lane state machine: poll, filter, dispatch, retry,
│                          reconcile, completion. Owns its WorkspaceManager.
├── agent-runner.ts        Per-issue execution. Drives a backend, translates events.
├── workspace.ts           Per-ticket clone-on-create / fetch-on-reuse / remove-on-success.
├── config.ts              Workflow file loader + Zod schemas. Supports $ENV_VAR refs.
├── prompt-builder.ts      Liquid renderer (the workflow prompt body is a Liquid template).
├── types.ts               Shared types: WorkflowConfig, BackendOptions, TokenUsage, etc.
├── backends/
│   ├── types.ts             AgentBackend interface + NormalizedEvent.
│   ├── claude.ts            @anthropic-ai/claude-agent-sdk driver. Uses local Claude
│   │                        Code subscription auth on the runner machine.
│   ├── open-agent.ts        @codeany/open-agent-sdk driver. Targets any
│   │                        OpenAI-compatible gateway (concentrate.ai today).
│   ├── codex.ts             Stub for future Codex/Symphony driver.
│   └── registry.ts          BackendKind → AgentBackend lookup.
├── trackers/              Tracker adapters (Linear implemented; GitHub / GitLab stubbed).
├── tools/                 Agent-callable functions. One file per tool + index factory.
│   ├── index.ts             buildToolsForWorkflow() wires tools per tracker.
│   └── linear-graphql.ts    Raw GraphQL passthrough with team API key.
├── skills/                Reusable prompt playbooks. One file per skill + index registry.
│   ├── index.ts             registerMaestroSkills() (idempotent) + MAESTRO_SKILLS array.
│   ├── git-start.ts         PR re-run detection + comment punch list + branch setup.
│   ├── acceptance-sync.ts   Flip Linear `- [ ]` → `- [x]` after implementing.
│   └── git-finish.ts        Commit + push + open/update PR + optional reviewer tag + Linear comment.
└── http/
    ├── server.ts            Hono server: /, /api/state, /api/events SSE, /healthz, basic auth.
    └── dashboard.ts         Embedded dashboard HTML.

bin/maestro.ts             CLI entry (commander). `start` and `validate` subcommands.

workflows/                 Workflow files = config-as-code. One per lane.
├── frontend.md              Example lane: web frontend, Figma tools, open-agent.
├── backend.md               Example lane: generic backend service, open-agent.
└── backend-python.md        Example lane: Python service with repo conventions.

Dockerfile, fly.toml, .dockerignore   Production deployment artifacts (Fly.io).
```

## The two backends, when to use which

| Backend | Auth | Model | Use when |
|---|---|---|---|
| `claude` | Local Claude Code OAuth (`~/.claude/`) | whatever Claude Code is logged in as | Running Maestro on someone's laptop with their Max/Pro subscription |
| `open-agent` | API key via `apiKey` + `baseURL` | anything concentrate.ai exposes | Running Maestro on a server (Fly), team-shared, no subscription auth available |

Production Maestro is **open-agent only** — subscription auth doesn't survive being hosted. The `claude` backend remains for local dev / experiments.

## Design decisions

How the open-agent backend and production setup came together, and why:

| Change | What |
|---|---|
| `feat: add open-agent backend` | New backend using `@codeany/open-agent-sdk` (the OSS equivalent of `@anthropic-ai/claude-agent-sdk` but supports any OpenAI-compatible gateway). |
| `fix(open-agent): bypass Zod 3/4 mismatch` | Maestro uses Zod 4, the SDK uses Zod 3. Custom tools crashed at call time. Fixed by serializing tool schemas to plain JSON Schema before handing to the SDK. |
| `feat(workspace): clone-per-ticket isolation` | New optional `workspace.repo: { url, branch }` config. WorkspaceManager git-clones the target repo into a fresh per-ticket dir. Agent's cwd is the clone — no `cd` step needed. Bypasses the SDK's BashTool being stateless w.r.t. cwd between commands. |
| `fix(open-agent): treat non-error result frames as success` | The SDK's result frame doesn't always have `subtype: "success"` even when everything worked. We were over-strict; switched to a deny-list of known error subtypes. |
| `chore: swap OpenRouter for concentrate.ai` | Workflow files now point at `https://api.concentrate.ai/v1`. Env var `CONCENTRATE_API_KEY`. |
| `feat(prod): Fly.io deployable image + dashboard auth + workspace cleanup` | Dockerfile, .dockerignore, fly.toml, `/healthz`, basic auth on the dashboard (activates only when both env vars are set), workspace cleanup on success. |
| `chore: unify workspace paths on /data/workspaces` | All workflow files now point at `/data/workspaces/<lane>`. Same path locally and in the container — fly volume mounts at `/data/workspaces`. |
| `feat(skills): extract reusable workflow boilerplate into skills` | ~80% of frontend.md / backend.md prompt bodies was duplicated playbook (PR comment walks, branch setup, Linear sync, commit/push/PR). Promoted into three open-agent skills (`gitStart`, `acceptanceSync`, `gitFinish`); workflow bodies shrink to ~15 lines. Includes `src/` reorg: `src/skills/`, `src/tools/`, `src/http/` folders (previously single files / mixed paths). |
| `feat(skills,workflows): add reviewer tagging; migrate backend lane` | `gitFinish` now accepts `reviewer: <handle>` via caller args and runs `gh pr edit <N> --add-reviewer <handle>` after PR open/update. `backend.md` migrated to `backend: open-agent` + concentrate.ai + `workspace.repo`. |

## Verified end-to-end

A real ticket was dispatched through `open-agent` → concentrate.ai → Claude Sonnet against a private Python/FastAPI service. The agent:

- Cloned the target repo into a per-ticket workspace ✅
- Read the existing `CLAUDE.md` for context ✅
- Wrote a quality `AGENTS.md` (Python/FastAPI/uv, ~95 lines) ✅
- Branched, committed, pushed and opened a PR ✅
- Posted a Linear comment with the PR link ✅
- Linear ticket auto-moved to `In Review` ✅

The session log (transcript) is at `~/.open-agent-sdk/sessions/<uuid>/transcript.json` on the runner machine — these accumulate forever right now.

## Deploying

### 1. Verify the image builds

```bash
docker build -t maestro:dev .
```

Watch for failures on the `gh` apt repo install — it adds GitHub's signing key and installs `gh` via apt. If their key/URL changes this'll break.

### 2. Smoke test the container locally

The files in `workflows/` are example lanes (`backend: open-agent` + concentrate.ai + clone-per-ticket). Copy one, point `workspace.repo.url`, `teamKey`, `labels` and the reviewer at your own setup, or add new files under `workflows/` for additional lanes.

Then:

```bash
docker run --rm -p 4001:4000 \
  -e LINEAR_API_KEY=lin_oauth_... \
  -e LINEAR_REFRESH_TOKEN=lin_refresh_... \
  -e LINEAR_CLIENT_ID=... \
  -e LINEAR_CLIENT_SECRET=... \
  -e GITHUB_TOKEN=github_pat_... \
  -e CONCENTRATE_API_KEY=conc_... \
  -e MAESTRO_WORKFLOWS=workflows/<your-workflow>.md \
  -e MAESTRO_DATA_DIR=/data/workspaces \
  -v /tmp/maestro-data:/data \
  maestro:dev
```

Hit `http://127.0.0.1:4001/healthz` — should return `{"ok":true,...}`. Basic auth is OFF because no `BASIC_AUTH_*` env vars set, so `/` works too. With appropriately-labelled tickets in Linear, dispatch should fire.

Important: when basic auth env vars are absent, the server logs a `WARN: HTTP server: basic auth DISABLED`. For prod, both `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` must be set or the dashboard ships unauthenticated. (See `src/http/server.ts:start()`.)

### 3. Investigate Fly.io specifics

The `fly.toml` is checked in but assumes `primary_region = "ord"`. Decide:

- **Region** — closer to wherever Linear's API lives. `ord` is fine for North America.
- **VM size** — `shared-cpu-1x, 1 GB` is the default. Probably enough; the agent loop is mostly I/O bound (LLM API + git network), not CPU.
- **Volume size** — fly.toml asks for a 10 GB volume. Each per-ticket workspace is one full clone of the target repo. A medium repo is ~200 MB → 50 simultaneous workspaces fit easily.
- **Auto-stop** — explicitly `false` because the orchestrator MUST be running to poll. Don't change.
- **min_machines_running = 1** — same reason. Don't drop to 0.

### 4. Run the actual deploy

The README's "Deploying to Fly.io" section is the runbook. Roughly:

```bash
fly launch --no-deploy
fly volumes create maestro_workspaces --size 10 --region ord
fly secrets set \
  LINEAR_API_KEY=lin_oauth_... \
  LINEAR_REFRESH_TOKEN=lin_refresh_... \
  LINEAR_CLIENT_ID=... \
  LINEAR_CLIENT_SECRET=... \
  GITHUB_TOKEN=... \
  CONCENTRATE_API_KEY=... \
  BASIC_AUTH_USER=team \
  BASIC_AUTH_PASSWORD=$(openssl rand -base64 24)
fly secrets set MAESTRO_WORKFLOWS="workflows/<your-workflow>.md"
fly deploy
```

Decide which workflow file(s) the production instance runs before deploying. Multiple files can be space-separated.

### 5. Verify post-deploy

- `curl https://<app>.fly.dev/healthz` → 200
- `https://<app>.fly.dev/` → basic auth challenge, then dashboard
- Create a `target:maestro-test`–labelled Linear ticket, watch the SSE event stream populate
- Confirm a PR shows up on the target repo from the `maestro-bot` account

## Watch out for these (we hit them during local testing)

**1. `gh` PAT permissions.** The `maestro-bot` account's token has to grant access to **every repo** Maestro is allowed to touch, with permissions: `Contents: read & write`, `Metadata: read`, `Pull requests: read & write`. Push works via git protocol even if the API doesn't, masking the failure. If `gh pr create` returns `Could not resolve to a Repository`, this is why.

**2. The SDK's BashTool is stateless.** Every bash command runs in a fresh shell. `cd` doesn't persist between commands. This is why clone-per-workspace exists (so the agent doesn't need to `cd` ever — its cwd is the clone). Don't add `cd /some/path` instructions to workflow prompts; chain `cd … && …` if you must, but prefer setting `workspace.repo`.

**3. Concentrate.ai model naming.** Provider-prefixed slugs (`anthropic/claude-sonnet-4-6`, `openai/gpt-5.4`) and `auto` for routing. Check `https://concentrate.ai/docs` for the current model list — slugs change.

**4. Workspace cleanup is only on success.** Failed runs leave the cloned workspace dir on disk for debugging. There's no periodic sweeper yet; if many tickets fail in a row the volume can fill. If this becomes a problem, the simplest fix is a cron-style sweep in `Lane.tick` deleting any workspace dir older than N days.

**5. Session log retention.** The SDK persists agent transcripts to `~/.open-agent-sdk/sessions/<uuid>/transcript.json`. In the container that's ephemeral; if you want them after a redeploy, ship them to S3/R2 on completion. Out of scope for v1.

**6. `~/.git` footgun (local-only).** If your `$HOME` is itself a git repo, this applies to you. If you ever run a workflow without `workspace.repo` set, the agent's cwd may have no `.git` of its own → git commands escape upward to `$HOME`. Clone-per-workspace makes this a non-issue for now, but worth knowing if you ever set up a workflow with no `repo` field.

## Things deliberately deferred

- **Session log shipping** to durable storage (S3/R2). Logs are ephemeral in the container.
- **Multi-region / scale.** Single VM is enough.
- **A/B testing different models.** Code supports it (set `model:` per workflow), nobody's done the experiment yet.
- **Periodic workspace sweep.** See "Watch out for" #4.
- **A real CI pipeline.** Unit tests exist (`pnpm test`, vitest) but nothing runs them automatically yet.

## Quick reference

```bash
# Validate a workflow file
pnpm tsx bin/maestro.ts validate -w workflows/<file>.md

# Run Maestro locally (Mac/Linux). Set MAESTRO_DATA_DIR in .env first
# (e.g. /Users/you/maestro-workspaces — does not need sudo).
pnpm tsx bin/maestro.ts start -w workflows/<file>.md -p 4001

# Typecheck
pnpm typecheck

# Build the Docker image
docker build -t maestro:dev .

# Check a fly app's logs
fly logs

# SSH into the Fly VM
fly ssh console

# View running workspaces inside the container
fly ssh console -C "ls -la /data/workspaces"

# Check the SDK transcripts
fly ssh console -C "find /root/.open-agent-sdk/sessions -name transcript.json"
```

## Open question to settle before deploying

**Which workflow file(s) does the production instance run?** `MAESTRO_WORKFLOWS` has no default in either the Dockerfile or fly.toml — the production lanes must be chosen explicitly. Pick one or more of the example files in `workflows/` (adapted to your repo), or add new ones. Set via:

```bash
fly secrets set MAESTRO_WORKFLOWS="workflows/frontend.md workflows/backend.md"
```

## Adding tools and skills

The `open-agent` backend gives the agent a ~30-tool baseline (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/Task/Cron/...) plus anything we register on top.

**To add a tool** (a function the agent can call):

1. Drop a file in `src/tools/` exporting a builder that returns `Promise<ToolDef>`.
2. Wire it into the appropriate tracker branch in `src/tools/index.ts:buildToolsForWorkflow()`.

**To add a skill** (a reusable prompt playbook the agent invokes via the built-in `Skill` tool):

1. Drop a file in `src/skills/` exporting a `SkillDefinition`. Set `userInvocable: true` so the agent sees it in its system-reminder.
2. Add it to `MAESTRO_SKILLS` in `src/skills/index.ts`.
3. Reference it from a workflow body: `Skill(skill="<name>", args="<optional caller args>")`.

Skills only apply to lanes using `backend: open-agent` — the Claude Agent SDK has its own separate skill mechanism that registrations here do not feed into.

---

If anything in here is unclear, the README and [`docs/harness.md`](./docs/harness.md) have more depth.
