# Maestro

Agent-agnostic orchestration for autonomous coding agents. Polls a tracker (Linear / GitHub / GitLab), spawns isolated agent runs against tickets, lands PRs, updates state. One daemon, N workflows.

> Inspired by [Symphony](https://github.com/openai/symphony) (OpenAI) and [hatice](https://github.com/mksglu/hatice). Designed to be backend-agnostic — Claude today, Codex/Aider/etc when we need them.

## Quick start

```bash
pnpm install
cp .env.example .env  # fill in LINEAR_API_KEY and GITHUB_TOKEN
pnpm dev start --workflows ./workflows/frontend.md ./workflows/backend.md --port 4000
```

Open `http://127.0.0.1:4000` for the dashboard.

## Concepts

- **Workflow file** — a markdown file with YAML frontmatter (config) + a Liquid prompt body. Defines a single lane: tracker filters, agent backend, agent options, and the prompt template the agent receives.
- **Lane** — one workflow's poll loop + dispatch + slot pool. Multiple lanes run in one daemon, share state and HTTP surface, but route tickets independently.
- **Backend** — the coding agent driver. Conforms to `AgentBackend`. `claude` is the only implemented backend in v0.1; `codex` is stubbed for future use.

## Architecture

```
bin/maestro.ts                 CLI entry
src/
  orchestrator.ts              tick loop, dispatch, retries, multi-lane
  workflow-runner.ts           per-lane state + filter
  backends/
    types.ts                   AgentBackend interface + NormalizedEvent
    claude.ts                  Claude SDK implementation
    codex.ts                   stub
  trackers/                    Linear / GitHub / GitLab adapters
  workspace.ts                 per-issue isolated worktrees
  http-server.ts               REST + SSE + dark dashboard
  config.ts                    workflow loader + zod schemas
  prompt-builder.ts            Liquid renderer
  types.ts                     shared types
workflows/
  frontend.md                  example: target:droid-fe
  backend.md                   example: target:droid-be
```

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```
