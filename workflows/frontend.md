---
name: frontend
tracker:
  kind: linear
  apiKey: $LINEAR_API_KEY
  teamKey: NEU
  activeStates: ["Todo", "In Progress"]
  terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"]
  assignee: "me"
  labels: ["target:maestro-fe", "route:auto"]
workspace:
  rootDir: ~/maestro-workspaces/frontend
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
   - If exactly one matching PR exists, treat this as a re-run. Capture its branch, number, and url.
   - Read all reviewer feedback you need to address:
     - PR-level review comments: `gh pr view <number> --comments`
     - Inline review threads: `gh api repos/:owner/:repo/pulls/<number>/comments --paginate`
     - Failing checks: `gh pr checks <number>`
4. Branch selection:
   - **Re-run path (PR exists):** `git checkout <existing-branch> && git pull --ff-only origin <existing-branch>`. Address every reviewer comment and any failing checks. Do not open a new PR.
   - **First-pass path (no PR):** `git checkout -b feat/{{ issue.identifier | downcase }}-<short-kebab-slug>` off latest `main`. The branch MUST start with `feat/{{ issue.identifier | downcase }}-`.
5. Implement the change. Run lint/tests/build as appropriate.
   - **Track acceptance criteria as you go.** If the issue description above contains markdown checkboxes (`- [ ]`), update the Linear issue's description to flip a box from `- [ ]` to `- [x]` *only after* the corresponding behavior is actually implemented and verified.
   - **How to update the description:** call the `linear_graphql` MCP tool with this mutation. Pass the issue's UUID (`{{ issue.id }}`) and the full revised description (Linear replaces the entire field):
     ```graphql
     mutation UpdateDescription($id: String!, $description: String!) {
       issueUpdate(id: $id, input: { description: $description }) { success }
     }
     ```
     Variables: `{ "id": "{{ issue.id }}", "description": "<full markdown with updated checkboxes>" }`.
   - Do NOT check a box you did not satisfy. Preserve all other content verbatim.
6. Commit with a message that starts with the ticket id, e.g. `{{ issue.identifier }}: <concise description>`.
7. Push the branch: `git push -u origin HEAD`
8. PR handling:
   - **First-pass:** open with `gh pr create --base main --head <branch> --title "{{ issue.identifier }}: {{ issue.title }}" --body "<summary + link to Linear issue>"`.
   - **Re-run:** the push updates the existing PR — do NOT open a new one. Optionally add a comment via `gh pr comment <number> --body "<what changed>"`.
9. Report the PR URL as the final line of your response.

Hard rules:
- Do all work on the ticket branch — never push to `main`.
- One ticket = one PR.
- If reviewer feedback is ambiguous, leave a PR comment asking for clarification rather than guessing.
