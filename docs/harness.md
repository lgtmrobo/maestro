# Maestro harness — what the agent actually sees at runtime

Audit of Maestro's runtime behavior. Every claim links to the source-of-truth `file:line`. Where the answer is "we don't know" (gateway internals, provider-side rewrites) it's called out explicitly rather than guessed.

The production lanes use `backend: open-agent` against `https://api.concentrate.ai/v1`. The `claude` backend exists for local-laptop development and is **not** what runs in Fly. Everything below describes the open-agent path unless noted.

---

## 1. Prompting

### 1.1 What the model actually receives

For every run, the SDK sends two top-level fields to the LLM:

- A **system prompt** assembled by `@codeany/open-agent-sdk` in `node_modules/@codeany/open-agent-sdk/src/engine.ts:79-138` (the `buildSystemPrompt` function).
- A **user prompt** = the rendered workflow template (Maestro produces this in `src/prompt-builder.ts:38`).

### 1.2 System prompt assembly (open-agent SDK)

Maestro does **not** override the system prompt — we don't pass `systemPrompt` in `backendOptions` for any lane (`workflows/*.md` show `permissionMode`, `apiType`, `baseURL`, `apiKey`, `model` only — no `systemPrompt`). So the SDK builds the default:

```
You are an AI assistant with access to tools. Use the tools provided to help the
user accomplish their tasks.
You should use tools when they would help you complete the task more accurately
or efficiently.

# Available Tools
- **Bash**: ...
- **Read**: ...
- **Edit**: ...
- ...(every tool we pass — base + custom — with its description)
- **linear_graphql**: Execute raw GraphQL against the Linear API...

# Environment
gitStatus: <output of `git status` from cwd>

# Project Context
# currentDate
Today's date is 2026-05-22.
# From <cwd>/AGENT.md:
<contents>
# From <cwd>/CLAUDE.md:
<contents>

# Working Directory
/data/workspaces/<lane>/<TICKET-ID>
```

Sources:
- `node_modules/@codeany/open-agent-sdk/src/engine.ts:91-138` — the preamble + sections.
- `node_modules/@codeany/open-agent-sdk/src/utils/context.ts:100-129` — files the SDK probes for project context: `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `claude.md` at the cwd, plus `~/.claude/CLAUDE.md`.
- `node_modules/@codeany/open-agent-sdk/src/utils/context.ts:156-165` — system context is currently just a one-line `git status` summary.
- `node_modules/@codeany/open-agent-sdk/src/utils/context.ts:170-183` — user context is today's date + the project context files above.

### 1.3 User prompt (workflow body, per-ticket)

`src/agent-runner.ts:62-66` renders the workflow's markdown body as a Liquid template (`src/prompt-builder.ts:38`) with one context object:

```typescript
{
  issue: { id, identifier, title, description, state, priority, labels, url, branch_name },
  attempt: { number, error: null }
}
```

That's the **entire** issue+repo context auto-injected by Maestro. The Liquid template can reference `{{ issue.identifier }}`, `{{ issue.description }}`, etc. See `src/prompt-builder.ts:18-30` for the exact field list.

The rendered body of e.g. `workflows/frontend.md` becomes the user-message content. Inspect any workflow file (lines below the YAML frontmatter) to see exactly what arrives at the model.

### 1.4 Safety rules and success criteria sent to the agent

These are **author-controlled in each workflow body**, not framework-enforced. Each workflow embeds its own "Hard rules" and "Workflow" sections:

- `workflows/frontend.md:50-62` — frontend hard rules ("Do all work on the ticket branch", "One ticket = one PR", etc.)
- `workflows/backend.md:59-65` — backend hard rules
- `workflows/backend-showrunner.md:74-82` — showrunner hard rules (incl. schema-migration / `gh pr comment` clarification rules)

There is **no Maestro-level guardrail prompt**. If the workflow body doesn't say "never push to main", nothing else will.

Skills bundled in `src/skills/` add structured playbooks that are pulled in on demand via the `Skill` tool (see §2.3): `gitStart`, `acceptanceSync`, `gitFinish`.

### 1.5 What is NOT injected

- No file contents from the repo (the agent reads them itself via `Read`/`Glob`/`Grep`).
- No prior Linear comments / PR history (the agent fetches them via `gh` and `linear_graphql`).
- No reviewer history beyond what `gitStart`'s `gh pr view --comments` produces at runtime.

---

## 2. Tooling

### 2.1 Built-in tools (~30, from the open-agent SDK)

Full list in `node_modules/@codeany/open-agent-sdk/src/tools/index.ts:71-134`. Authoritative — copy verbatim:

| Category | Tools |
|---|---|
| File I/O | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit` |
| Web | `WebFetch`, `WebSearch` |
| Agent / multi-agent | `Agent`, `SendMessage`, `TeamCreate`, `TeamDelete` |
| Tasks | `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskGet`, `TaskStop`, `TaskOutput` |
| Worktree | `EnterWorktree`, `ExitWorktree` |
| Planning | `EnterPlanMode`, `ExitPlanMode` |
| User interaction | `AskUserQuestion` |
| Discovery | `ToolSearch` |
| MCP resources | `ListMcpResources`, `ReadMcpResource` |
| Scheduling | `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger` |
| LSP | `LSP` |
| Config | `Config` |
| Todo | `TodoWrite` |
| Skill | `Skill` (this is the entry point to the registered skills below) |

These ship from the SDK as-is. Their schemas and behavior live in `node_modules/@codeany/open-agent-sdk/src/tools/<name>.ts` (one file per tool). To see the exact JSON schema sent to the model for any of them, grep that directory.

Maestro never sets `allowedTools` / `disallowedTools` in `backendOptions` for any lane today, so all 30 are exposed.

### 2.2 Custom tools per workflow

Built in `src/tools/index.ts:16-23`. Today: exactly one custom tool when the tracker kind is `linear` — `linear_graphql`. That's it. Definition: `src/tools/linear-graphql.ts:15-55`.

To see the exact name, description, and schema sent to the model, read those two files. There are no other custom tools — `src/tools/` only contains `index.ts` + `linear-graphql.ts`.

### 2.3 Skills (open-agent-only, registered globally)

Registered in `src/skills/index.ts:22-26`:

- `gitStart` — `src/skills/git-start.ts` — PR detection + comment walk + branch setup. Allowed tools (declared in the skill itself): `Bash`, `Read`, `Grep`, `Glob`. See `src/skills/git-start.ts:78`.
- `acceptanceSync` — `src/skills/acceptance-sync.ts` — flip Linear `- [ ]` → `- [x]`. Allowed tools: `linear_graphql` only. See `src/skills/acceptance-sync.ts:44`.
- `gitFinish` — `src/skills/git-finish.ts` — commit/push/PR/Linear-comment. Allowed tools: `Bash`, `Read`, `Grep`, `Glob`, `linear_graphql`. See `src/skills/git-finish.ts:98`.

The full prompts each skill injects are the `PROMPT = \`…\`` constants at the top of each skill file — that is the literal text the model sees when it invokes one.

### 2.4 Tool schema delivery

Custom tools (`linear_graphql`) are defined with Zod 4 in Maestro, converted to JSON Schema at registration time (`src/backends/open-agent.ts:150-173`), then handed to the SDK's `defineTool`. The JSON Schema that ends up in the wire request to the model is whatever `z.toJSONSchema(...)` produces from `src/tools/linear-graphql.ts:24-30`. Two properties: `query: string`, `variables: record<string, unknown> (optional)`.

Base-tool schemas are SDK-owned — Maestro doesn't see or modify them.

---

## 3. Model / runtime configuration

Everything below is **per-workflow** in the YAML frontmatter (`workflows/*.md`). Validated by `src/config.ts:55-69` (the `backendOptionsSchema`).

### 3.1 Per-workflow values today

| Setting | `frontend.md` | `backend.md` | `backend-showrunner.md` | Source |
|---|---|---|---|---|
| `backend` | `open-agent` | `open-agent` | `open-agent` | workflow `backend:` |
| `apiType` | `openai-completions` | `openai-completions` | `openai-completions` | workflow `backendOptions.apiType` |
| `baseURL` | `https://api.concentrate.ai/v1` | same | same | workflow `backendOptions.baseURL` |
| `apiKey` | `$CONCENTRATE_API_KEY` | same | same | env var resolved in `src/config.ts:114-140` |
| `model` | `anthropic/claude-sonnet-4-6` | same | same | workflow `backendOptions.model` |
| `permissionMode` | `bypassPermissions` | same | same | workflow `backendOptions.permissionMode` |
| `maxTurns` | 150 | 150 | 150 | workflow `agent.maxTurns` |
| `maxConcurrent` | 2 | 2 | 2 | workflow `agent.maxConcurrent` |
| `polling.intervalMs` | 15000 | 15000 | 15000 | workflow `polling.intervalMs` |
| `completionState` | `In Review` | `In Review` | `In Review` | workflow `agent.completionState` |
| `inProgressState` | `In Progress` | `In Progress` | `In Progress` | workflow `agent.inProgressState` |
| `turnTimeoutMs` | 3_600_000 (1h) default | same | same | `src/config.ts:61` |

### 3.2 Things Maestro doesn't set (so the SDK uses its defaults)

- **Temperature** — Maestro never passes a temperature; whatever default the SDK uses for the chosen `apiType` reaches the provider untouched. The exact default is in `node_modules/@codeany/open-agent-sdk/src/engine.ts` (the request-builder); not enumerated here.
- **Stop conditions** — only `maxTurns: 150`. No `stop_sequences`, no token cap. The agent ends on `result` event or hits the turn cap.
- **systemPrompt** — unset (uses SDK default; see §1.2).
- **allowedTools / disallowedTools** — null (all base + custom tools available).
- **resumeSessionId** — only used internally for retries; not exposed in workflow config.

### 3.3 Fixed vs configurable

Everything in the table above is **per-workflow configurable** by editing the YAML frontmatter. To override `maxTurns`, `temperature` would need a Maestro change (Zod schema doesn't allow it today) — `src/config.ts:55-69`. To override the system prompt, set `backendOptions.systemPrompt: "..."` in the workflow (the SDK respects it — `engine.ts:79`).

---

## 4. Execution environment

### 4.1 Environment variables exposed to the agent

The agent process sees `process.env` plus a small additive set:

- `bin/maestro.ts:52-57` — adds `GH_TOKEN` and `GITHUB_TOKEN` (both set from the host's `GITHUB_TOKEN`).
- `src/lane.ts:310` — spreads `{ ...process.env, ...agentEnv }` into the runner.
- `src/agent-runner.ts:84` — passes that env into `backend.run({ ..., env })`.
- `src/backends/open-agent.ts:80` — hands the env to the SDK's `query()`.

In practice the agent sees a **filtered** subset of the orchestrator process env. `src/agent-env.ts` strips known-secret names — `LINEAR_REFRESH_TOKEN`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_API_KEY`, `CONCENTRATE_API_KEY`, `BASIC_AUTH_*` — plus anything matching `/SECRET/i`, `/PASSWORD/i`, `/PASSWD/i`. Infrastructure env (PATH, HOME, USER, locale, toolchain) passes through unchanged. `GH_TOKEN` / `GITHUB_TOKEN` are added back explicitly because the `gh` CLI needs them.

### 4.2 Filesystem boundaries

There are **none enforced by Maestro**. `permissionMode: bypassPermissions` (`workflows/*.md:29`, `engine.ts` resolution) disables interactive confirms, and the SDK does not chroot or restrict file access. The `Bash` and `Edit`/`Write` tools can touch anything the OS user can touch.

Effective boundary: in production (Fly), the container fs is the boundary. The agent's cwd is `/data/workspaces/<lane>/<TICKET-ID>` (a fresh clone — `src/workspace.ts:38-99`). Workspaces are cleaned up after success (`src/lane.ts:400-411`).

Locally, there is no effective boundary — the agent can read `~/.ssh`, `~/.aws`, etc. This is one of the reasons production is open-agent in a container, not `claude` locally.

### 4.3 Network access

Unbounded. The SDK's `WebFetch`, `WebSearch`, and especially `Bash` (which can run `curl`, `npm install`, `gh api`, etc.) place no domain restrictions. In Fly, outbound is whatever the VM's egress allows.

### 4.4 Bash sandboxing in practice

Bash tool implementation: `node_modules/@codeany/open-agent-sdk/src/tools/bash.ts`. Runs the command via Node's `child_process` in a fresh shell per call — **no persistent state between calls**, which is why workflows say "do not `cd`" (see `workflows/frontend.md:42`, etc.). No timeouts beyond what the SDK enforces; no allow/deny list of binaries.

---

## 5. Gateway behavior (concentrate.ai)

**This is the section we cannot fully answer from our codebase.** What follows is what *we* configure plus what we know empirically:

### 5.1 What Maestro sends to the gateway

OpenAI-completions wire format (because `apiType: openai-completions`) to `https://api.concentrate.ai/v1/chat/completions` (the SDK appends the path; `src/backends/open-agent.ts:88`). Model field literally says `anthropic/claude-sonnet-4-6` — a provider-prefixed slug interpreted by concentrate, not OpenAI's namespace.

### 5.2 What we DO NOT know from this repo

- **Provider routing** — does concentrate map `anthropic/claude-sonnet-4-6` to one concrete provider, or multiple with fallback? Unknown.
- **Retry / failover** — does concentrate retry on upstream 5xx, and if so how many times and with what jitter? Unknown.
- **Caching** — Anthropic-native prompt caching (`cache_control` blocks) does flow through if the SDK emits it; whether concentrate adds its own response cache layer on top is unknown.
- **Request/response rewrites** — concentrate is free to (and likely does) translate our `openai-completions` request into the Anthropic Messages format upstream, then re-translate the response. Whether it adds, strips, or modifies fields (e.g. tool definitions, system prompt) is unknown.
- **Logging / retention** — what concentrate logs about our requests, where, for how long. Unknown.

Action: ask the concentrate.ai team for: (1) provider list and routing policy for the slugs we use, (2) retry/timeout config, (3) data retention and what's logged, (4) whether they ever rewrite tool definitions or system prompts in transit. Pin the answers in a follow-up section here.

---

## 6. Linear access (what `linear_graphql` allows)

### 6.1 Scope

`linear_graphql` is a **raw GraphQL pass-through** to `https://api.linear.app/graphql`. See `src/tools/linear-graphql.ts:36-46`. It is **not read-only** — the agent can run any query, mutation, or subscription Linear's schema exposes that the token's scopes allow.

### 6.2 Token + actor

Bound at build time to whatever `tracker.apiKey` is for the lane (`src/tools/index.ts:19-21`). That's the same `LINEAR_API_KEY` env var, currently a `lin_oauth_…` token issued via `actor=app` — so requests are attributed to the Maestro app actor, not a user.

Linear's OAuth scopes for that token: `read,write,app:assignable,app:mentionable` (from the install flow). `read` + `write` is what gates mutation surface. With those, the agent can:
- Read any issue, comment, project, team, label the workspace exposes to the app.
- Mutate: create/update/delete issues, comments, descriptions, states, labels, project assignments. Anything `write` covers in Linear's schema.

`src/tools/linear-graphql.ts` auto-detects token type: `Bearer <token>` for `lin_oauth_*`, bare for `lin_api_*`. Mirrors the same logic in `src/trackers/linear/client.ts:143-145`.

### 6.3 Workspace / team scope

The OAuth install is scoped to the **NeukoAI workspace** (org id `140f07fe-24d2-4854-a2f9-2884c952959a`). Within that workspace the token has access to whatever resources match its scopes — there is no `team` restriction at the token level. The lane's `tracker.teamKey: NEU` only filters issue *polling*, not what `linear_graphql` can touch. The agent could query any team in the workspace if it constructed the right query.

---

## 7. Observability and reproducibility

### 7.1 SDK transcript

The SDK persists every run to `~/.open-agent-sdk/sessions/<session-uuid>/transcript.json`. Path computed in `node_modules/@codeany/open-agent-sdk/src/session.ts:39`. Contains every assistant message (text + tool calls), every tool result, and the final `result` event with `stop_reason`, usage, cost.

In Fly, that directory is **inside the container's ephemeral FS**, so transcripts are lost on redeploy. Mentioned in `CONTRIBUTING.md` ("Watch out for" item #5). Each Maestro trace bundle (below) carries a pointer to this path.

### 7.2 Live event stream

`src/agent-runner.ts:88-128` translates SDK events into normalized events and emits them via the lane EventEmitter. The HTTP server (`src/http/server.ts`) exposes:
- `GET /api/state` — current `running` / `retries` / `completed` per lane (`src/http/server.ts:103`).
- `GET /api/events` — SSE stream of agent events as they happen (`src/http/server.ts:109`).

These show event *kinds* (`tool_result`, `assistant_text`, etc.) but truncate full payloads to 200 chars (`src/agent-runner.ts:93`).

### 7.3 Per-run trace bundles

Every dispatch writes a JSON trace under `${MAESTRO_DATA_DIR}/traces/<traceId>.json` containing:

- **Rendered prompt** — exactly what was sent to the model.
- **Custom tool manifest** — name + description + JSON Schema for every Maestro-injected tool. Base SDK tools (~30) are implied by the pinned SDK version.
- **Backend options** — model, baseURL, permissionMode, etc. Fields matching `/key|secret|token|password|passwd/i` are replaced with `"[redacted]"`.
- **SDK session id** + computed path to the SDK's transcript (above).
- **Outcome** — `normal | cancelled | error`, stop reason, duration, total tokens, error message if any.

Source: `src/trace.ts` (writer), `src/agent-runner.ts` (capture hooks), `src/http/server.ts` (API).

HTTP:

| Endpoint | Returns |
|---|---|
| `GET /api/traces?lane=&issueId=&limit=&include=running` | Summary list, recent first; finished-only by default. |
| `GET /api/trace/:traceId` | Full record. |

Dashboard surfaces a **Past Runs** section listing recent traces (recent-first) with outcome pills and durations. Live and past rows are clickable; clicking opens a modal showing the full bundle (prompt, tools, backend options, error, transcript path).

### 7.4 What is still NOT captured

- **The model selection trail** — we know what we asked for (`model: anthropic/claude-sonnet-4-6`); we do **not** know what concentrate.ai ultimately routed to. The SDK doesn't log gateway response headers.
- **Tool inputs and outputs as full strings (in real-time stream)** — the SSE stream truncates to 200 chars; full payloads live only in the SDK's transcript file.
- **Replay** — there is no replay path. The SDK has a `resume: <session-id>` option (`src/backends/open-agent.ts:83`) but we only use it for retries within the same process, not for offline reconstruction.
- **Full base-tool manifest** — only Maestro-injected custom tools land in the trace bundle; the SDK's ~30 base tool schemas are implied by SDK version.

---

## 8. Control surfaces — current status

| Surface | Inspectable | Adjustable |
|---|---|---|
| Final rendered prompt | ✅ trace bundle (`/api/trace/:id`) | ✅ via workflow body |
| Custom tool manifest (Maestro-injected) | ✅ trace bundle | ✅ `src/tools/` |
| Base tool manifest (SDK-provided) | ❌ implied by SDK version | ✅ via `backendOptions.allowedTools/disallowedTools` (schema extension needed in `src/config.ts`) |
| Model + runtime settings per workflow | ✅ workflow frontmatter | ✅ workflow frontmatter |
| Backend options (model, baseURL, etc.) | ✅ trace bundle (secrets redacted) | ✅ workflow frontmatter |
| Gateway routing / fallback | ❌ external (concentrate.ai) | ❌ external |
| Env vars exposed to agent | ✅ `src/agent-env.ts` filter | ✅ deny set + regex |
| Linear ops | ✅ OAuth scopes (`read,write,app:assignable,app:mentionable`) | ✅ rotate via OAuth re-install |

---

## Open follow-ups

1. **Concentrate.ai gateway internals** — §5.2, requires input from the concentrate team.
2. **Filesystem / network sandboxing for the agent** — §4.2, would require container-level policy (seccomp, network egress rules).
3. **Linear OAuth scope tightening** — currently workspace-wide read+write; could be narrowed if Linear adds finer-grained app scopes.
4. **`linear_graphql` access-token staleness** — the tool builds its closure once at boot. The orchestrator's `LinearClient` refreshes on 401 but the tool's closure does not, so agent-side Linear writes will start 401-ing ~24h after process start. Fix is structural (share `LinearClient` or pass an auth-fn).
5. **Trace retention sweep** — `${MAESTRO_DATA_DIR}/traces/` grows unbounded.
6. **SDK transcripts persistence** — referenced by `trace.transcriptPath` but ephemeral in the Fly container. Ship to durable storage (S3/R2) on completion.
7. **Full base-tool manifest in traces** — needs SDK cooperation to expose schemas at call time.
