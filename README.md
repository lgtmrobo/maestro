# Maestro

Agent-agnostic orchestration for autonomous coding agents. Polls a tracker (Linear / GitHub / GitLab), spawns isolated agent runs against tickets, lands PRs, updates state. One daemon, N workflows.

> Inspired by [Symphony](https://github.com/openai/symphony) (OpenAI) and [hatice](https://github.com/mksglu/hatice). Backend-agnostic — drives Claude directly, any OpenAI-compatible gateway via `open-agent`, and (eventually) Codex.

## Running it

Production target is Fly.io — see [Deploying to Fly.io](#deploying-to-flyio) below for the deploy runbook.

For local testing:

```bash
pnpm install
cp .env.example .env   # fill in LINEAR_API_KEY, GITHUB_TOKEN, CONCENTRATE_API_KEY,
                       # and MAESTRO_DATA_DIR (e.g. /Users/you/maestro-workspaces)
pnpm tsx bin/maestro.ts start -w workflows/<your-workflow>.md -p 4001
```

Open `http://127.0.0.1:4001` for the dashboard.

Workflow `workspace.rootDir` is `${MAESTRO_DATA_DIR}/<lane>` — same file works locally and in the container. In production the container sets `MAESTRO_DATA_DIR=/data/workspaces` to match the Fly volume mount.

## Concepts

- **Workflow file** — markdown with YAML frontmatter (config) + Liquid prompt body. Defines a single lane: tracker filters, agent backend, options, and the prompt template.
- **Lane** — one workflow's poll loop + dispatch + slot pool. Multiple lanes run in one daemon, share state and the HTTP surface, route tickets independently.
- **Backend** — the coding agent driver. Conforms to `AgentBackend`.
  - `claude` — `@anthropic-ai/claude-agent-sdk`, uses local Claude Code subscription auth.
  - `open-agent` — `@codeany/open-agent-sdk`, in-process loop against any OpenAI-compatible or Anthropic-messages endpoint (concentrate.ai, OpenRouter, LiteLLM, etc).
  - `codex` — stubbed for future use.
- **Workspace** — per-ticket scratch dir. When `workspace.repo` is set, the dir is a fresh `git clone` of that repo (or `git fetch` + reset on re-use). Cleaned up on successful completion.
- **Tool** — function call the agent can invoke (e.g. `linear_graphql`). Drop a file in `src/tools/`, wire it into the factory. The SDK auto-includes ~30 built-ins (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/etc) on the `open-agent` backend.
- **Skill** — reusable prompt-template playbook the agent invokes via the built-in `Skill` tool (e.g. `gitStart`, `acceptanceSync`, `gitFinish`). Drop a file in `src/skills/`, add it to the registry. `open-agent` only — Claude SDK has its own separate skill mechanism.

## Architecture

```
bin/maestro.ts                 CLI entry
src/
  orchestrator.ts              multi-lane coordinator
  lane.ts                      per-lane tick loop, dispatch, retries
  agent-runner.ts              one agent execution
  workspace.ts                 clone-per-ticket, fetch-on-reuse
  config.ts                    workflow loader + zod schemas
  prompt-builder.ts            Liquid renderer
  backends/
    types.ts                   AgentBackend interface + NormalizedEvent
    claude.ts                  Claude Agent SDK driver
    open-agent.ts              OpenAI-compatible gateway driver
    codex.ts                   stub
    registry.ts                kind → backend lookup
  trackers/                    Linear / GitHub / GitLab adapters
  tools/                       agent-callable functions (linear_graphql, ...)
  skills/                      reusable prompt playbooks (gitStart, acceptanceSync, gitFinish)
  http/
    server.ts                  Hono server + SSE + healthz + basic auth
    dashboard.ts               embedded dashboard HTML
workflows/
  frontend.md                  open-agent + concentrate.ai, neuko-core@dev
  backend.md                   open-agent + concentrate.ai, neuko-services@dev
```

`workflows/frontend.md` and `workflows/backend.md` are working Neuko production lanes using the `open-agent` backend through concentrate.ai. Adapt them or add new files for additional lanes.

## Configuring a workflow against a gateway

```yaml
backend: open-agent
backendOptions:
  apiType: openai-completions
  baseURL: https://api.concentrate.ai/v1
  apiKey: $CONCENTRATE_API_KEY
  model: anthropic/claude-sonnet-4-6   # or openai/gpt-5.4, or "auto"
  permissionMode: bypassPermissions
```

`apiType` is the wire protocol shape, not the vendor. For 99% of gateways (concentrate, OpenRouter, LiteLLM, Vercel AI Gateway, Together, Groq, ...) use `openai-completions`.

## Skills

Workflows shrink dramatically when reusable boilerplate is promoted to skills. `src/skills/` holds three today:

| Skill | Purpose |
|---|---|
| `gitStart` | Detect existing PR for the ticket; walk every reviewer/bot comment into a punch list; set up the working branch (re-run checkout vs first-pass `feat/<id>-<slug>`). |
| `acceptanceSync` | Flip Linear acceptance-criteria checkboxes (`- [ ]` → `- [x]`) via `linear_graphql` once the corresponding behavior is implemented and verified. |
| `gitFinish` | Commit, push, open OR update the PR, optionally `--add-reviewer <handle>` (passed via skill `args`), post the PR link as a Linear comment. |

Workflow bodies invoke them by name: `Skill(skill="gitStart")`, `Skill(skill="gitFinish", args="reviewer: lgtmrobo")`, etc. Skill prompts are injected into the conversation when invoked, with optional `allowedTools` whitelists to scope each one.

Skills are registered against `@codeany/open-agent-sdk`'s registry and only apply to lanes using `backend: open-agent`. To add a skill: drop a file in `src/skills/` exporting a `SkillDefinition`, add it to the `MAESTRO_SKILLS` array in `src/skills/index.ts`.

## Clone-per-workspace

When a workflow declares `workspace.repo`, each ticket gets a fresh clone of that repo (or a `git fetch + reset` on re-use). The agent's cwd is the clone — no manual `cd` step in the prompt.

```yaml
workspace:
  rootDir: /data/workspaces/services
  repo:
    url: https://github.com/NeukoAI/neuko-services.git
    branch: dev
```

For github.com HTTPS URLs, `$GITHUB_TOKEN` is embedded at clone time so the bot account authenticates non-interactively. SSH URLs and other hosts use the runner's git credential setup.

Workspaces are deleted on successful completion. Failed workspaces are left for debugging.

## Linear: OAuth agent vs personal API key

Maestro authenticates to Linear with whatever you put in `LINEAR_API_KEY`. Two modes:

- **OAuth agent (`lin_oauth_…`)** — non-billable, posts as the "Maestro" app. Requires registering an OAuth application in Linear and completing the `actor=app` install flow once. Access tokens expire every ~24h and are refreshed in-process via `LINEAR_REFRESH_TOKEN` + `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET`.
- **Personal API key (`lin_api_…`)** — simpler, but uses a paid user seat and attributes all activity to that user.

### One-time OAuth agent setup

1. Create an application at https://linear.app/settings/api/applications/new. Note the **client id**, **client secret**, and a **redirect URI**.
2. Have a workspace admin visit the authorize URL (one line, fill in your values):

   ```
   https://linear.app/oauth/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<REDIRECT_URI>&scope=read,write,app:assignable,app:mentionable&actor=app&state=setup
   ```

   Approve. The browser will redirect to `<REDIRECT_URI>?code=<CODE>…` — copy the `code` from the URL bar (the redirect page itself may 404; that's fine).
3. Exchange the code for tokens within 10 minutes:

   ```bash
   curl -X POST https://api.linear.app/oauth/token \
     -d "code=<CODE>" \
     -d "redirect_uri=<REDIRECT_URI>" \
     -d "client_id=<CLIENT_ID>" \
     -d "client_secret=<CLIENT_SECRET>" \
     -d "grant_type=authorization_code"
   ```

   Save `access_token` → `LINEAR_API_KEY`, `refresh_token` → `LINEAR_REFRESH_TOKEN`.
4. Verify it's installed as an app:

   ```bash
   curl https://api.linear.app/graphql \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ viewer { name email } }"}'
   ```

   `viewer.email` should end in `@oauthapp.linear.app` — confirms app actor.

Maestro will then refresh the access token on demand whenever it gets a 401 from Linear, so you only need to rotate the refresh token if Linear's API tells you it has been revoked.

## Deploying to Fly.io

```bash
# One-time
fly launch --no-deploy                            # accept defaults; fly.toml is already checked in
fly volumes create maestro_workspaces --size 10 --region <region>
fly secrets set \
  LINEAR_API_KEY=lin_oauth_... \
  LINEAR_REFRESH_TOKEN=lin_refresh_... \
  LINEAR_CLIENT_ID=... \
  LINEAR_CLIENT_SECRET=... \
  GITHUB_TOKEN=github_pat_... \
  CONCENTRATE_API_KEY=conc_... \
  BASIC_AUTH_USER=team \
  BASIC_AUTH_PASSWORD=$(openssl rand -base64 24)

# Pick which workflow file(s) the production instance runs.
# Space-separate multiple paths. Path is relative to repo root inside the container.
fly secrets set MAESTRO_WORKFLOWS="workflows/<your-prod-workflow>.md"

# Deploy
fly deploy
```

The dashboard is reachable at `https://<your-app>.fly.dev/` and protected by basic auth. Healthcheck (`/healthz`) is unauthenticated so Fly's probe can hit it.

To run multiple workflow files on one instance:

```bash
fly secrets set MAESTRO_WORKFLOWS="workflows/services.md workflows/frontend.md workflows/backend.md"
fly deploy
```

Workspaces live on the mounted volume at `/data/workspaces`. Update each workflow's `workspace.rootDir` to a subdir of that path before deploying.

## Environment variables

| Var | Required? | Purpose |
|---|---|---|
| `LINEAR_API_KEY` | If using Linear tracker | Linear token — either an OAuth agent access token (`lin_oauth_…`, non-billable) or a personal API key (`lin_api_…`, billable seat) |
| `LINEAR_REFRESH_TOKEN` | If `LINEAR_API_KEY` is `lin_oauth_*` | OAuth refresh token returned from the `actor=app` token exchange |
| `LINEAR_CLIENT_ID` | If `LINEAR_API_KEY` is `lin_oauth_*` | OAuth client id from your Linear application |
| `LINEAR_CLIENT_SECRET` | If `LINEAR_API_KEY` is `lin_oauth_*` | OAuth client secret from your Linear application |
| `GITHUB_TOKEN` | If clone-per-workspace against private github | Bot PAT; also exported to agent as `GH_TOKEN` so `gh` auths |
| `CONCENTRATE_API_KEY` | If using `open-agent` backend | concentrate.ai gateway key |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Production only | Dashboard auth. Both must be set for auth to activate; otherwise local-dev mode (no auth) |
| `MAESTRO_WORKFLOWS` | In container | Space-separated workflow paths |
| `MAESTRO_PORT` | Optional | Listen port (default 4000) |
| `MAESTRO_HOST` | Optional | Listen host (default 0.0.0.0 in container, 127.0.0.1 in CLI) |

## Development

```bash
pnpm typecheck
pnpm test          # no test files yet
pnpm build
pnpm tsx bin/maestro.ts validate -w workflows/<file>.md   # syntax check a workflow
```
