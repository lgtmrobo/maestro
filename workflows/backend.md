---
name: backend
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
  labels: ["target:maestro-be", "route:auto"]
workspace:
  rootDir: ${MAESTRO_DATA_DIR}/backend
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
- Your cwd is already a fresh clone of the target repo on `dev`. **Do not `cd`** — bash commands are stateless and `cd` won't persist between invocations.

## Workflow

Run these three skills in order, with backend implementation work in between:

1. **`Skill(skill="gitStart")`** — detects an existing PR for this ticket, walks every reviewer/bot comment into a punch list, and sets up the working branch (re-run checkout or `feat/{{ issue.identifier | downcase }}-<slug>` first-pass).

2. **Implement the change.** Backend best practices:
   - Update database migrations alongside schema changes; never edit existing applied migrations. Migrations must be additive and reversible unless the ticket explicitly authorizes a destructive change.
   - Add or update tests for any new endpoint, query, or service. Run `pnpm test` (or the project's equivalent) before moving on.
   - Validate API contracts against existing consumers; if a breaking change is required, flag it in the PR body.
   - As you finish each verifiable acceptance criterion in the description, call **`Skill(skill="acceptanceSync")`** to flip the corresponding `- [ ]` to `- [x]`. You may call this multiple times.
   - On a re-run, address every item from the `gitStart` punch list — bot or human reviewer feedback, failing checks, all of it.

3. **`Skill(skill="gitFinish", args="reviewer: your-reviewer")`** — commit with `{{ issue.identifier }}: <…>` messages, push, open or update the PR against `dev`, request review from `@your-reviewer`, and post the PR link as a Linear comment on UUID `{{ issue.id }}`. End your response with the PR URL on its own line.

## Hard rules

- Do all work on the ticket branch — never push to `dev` directly.
- One ticket = one PR.
- Never modify production-only config (e.g. secrets, keys, billing endpoints) without explicit ticket authorization.
- If reviewer feedback is ambiguous or contradicts the ticket, leave a `gh pr comment` asking for clarification rather than guessing.
- Never check an acceptance-criteria box you did not actually implement and verify.
