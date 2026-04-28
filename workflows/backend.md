---
name: backend
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  teamKey: NEU
  activeStates: ["Todo", "In Progress"]
  terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"]
  assignee: "me"
  labels: ["target:maestro-be", "route:auto"]
workspace:
  rootDir: ~/maestro-workspaces/backend
polling:
  intervalMs: 15000
agent:
  maxConcurrent: 2
  maxTurns: 150
backend: claude
backendOptions:
  model: sonnet
  permissionMode: bypassPermissions
---

Solve this issue: **{{ issue.identifier }}** - {{ issue.title }}

{{ issue.description }}

## Workflow

1. `cd /Users/lucasrobitaille/Documents/Repos/neuko-core`
2. Make sure you are on the latest `main`:
   - `git fetch origin`
   - `git checkout main && git pull --ff-only origin main`
3. **Check for an existing PR for this ticket** — this may be a follow-up pass:
   - `gh pr list --search "{{ issue.identifier }} in:title" --state open --json number,headRefName,url,title`
   - If exactly one matching PR exists, treat this as a re-run. Read PR comments, inline review threads, failing checks.
4. Branch selection:
   - **Re-run path:** `git checkout <existing-branch> && git pull --ff-only origin <existing-branch>`. Address every reviewer comment and failing check.
   - **First-pass path:** `git checkout -b feat/{{ issue.identifier | downcase }}-<short-kebab-slug>` off latest `main`.
5. Implement the change with backend best practices in mind:
   - Update database migrations alongside schema changes; never edit existing applied migrations.
   - Add or update tests for any new endpoint, query, or service. Run `pnpm test` (or the project's equivalent) before pushing.
   - Validate API contracts against existing consumers; if a breaking change is required, flag it in the PR body.
   - **Track acceptance criteria** by flipping `- [ ]` → `- [x]` in the Linear issue description (UUID `{{ issue.id }}`) via the `linear_graphql` tool with `issueUpdate(id, input: { description })`.
6. Commit with `{{ issue.identifier }}: <concise description>` style messages. Multiple commits are fine.
7. Push: `git push -u origin HEAD`
8. PR handling:
   - **First-pass:** `gh pr create --base main --head <branch> --title "{{ issue.identifier }}: {{ issue.title }}" --body "<summary + migration notes + link to Linear issue>"`.
   - **Re-run:** push updates the existing PR — no new PR.
9. Report the PR URL on the final line.

Hard rules:
- Migrations must be additive and reversible unless the ticket explicitly authorizes a destructive change.
- Never modify production-only config (e.g. secrets, keys, billing endpoints) without explicit ticket authorization.
- One ticket = one PR.
