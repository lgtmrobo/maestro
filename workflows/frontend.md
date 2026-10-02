---
name: frontend
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
  labels: ["target:maestro-fe", "route:auto"]
workspace:
  rootDir: ${MAESTRO_DATA_DIR}/frontend
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

## Reading Figma designs

If the ticket links a `figma.com/design/...?node-id=...` URL, you have three Figma REST API tools available:

- **`figma_get_node(fileKey, nodeIds[])`** — fetches the raw node tree(s) for one or more nodes. Returns `absoluteBoundingBox`, `fills` (colors), text `style` (font family/size/weight/lineHeight/letterSpacing), `characters` (text content), `cornerRadius`, and child nodes. Use this to extract exact colors, type specs, and layout coordinates — do not guess from screenshots.
- **`figma_render_node(fileKey, nodeIds[], format, scale)`** — renders nodes as PNG/JPG/SVG/PDF and returns short-lived signed URLs. URLs expire in ~30 minutes, so `curl` them into the workspace immediately after the call.
- **`figma_get_image_fills(fileKey)`** — resolves every `imageRef` in image fills to a download URL. Call this when `figma_get_node` shows a node has an image fill and you need the raw asset.

Node IDs from a URL like `?node-id=292-3565` use a dash; the tools accept either `292-3565` or `292:3565`.

If these tools are unavailable (the `FIGMA_API_KEY` env var is unset on this deployment), the ticket description should contain inlined design specs — implement against those instead of trying `WebFetch` on figma.com URLs (they require auth and will fail).

## Workflow

Run these three skills in order, with frontend implementation work in between:

1. **`Skill(skill="gitStart")`** — detects an existing PR for this ticket, walks every reviewer/bot comment into a punch list, and sets up the working branch (re-run checkout or `feat/{{ issue.identifier | downcase }}-<slug>` first-pass).

2. **Implement the change.** Frontend best practices:
   - Run lint / tests / build as appropriate before moving on.
   - As you finish each verifiable acceptance criterion in the description, call **`Skill(skill="acceptanceSync")`** to flip the corresponding `- [ ]` to `- [x]`. You may call this multiple times.
   - On a re-run, address every item from the `gitStart` punch list — bot or human reviewer feedback, failing checks, all of it.

3. **`Skill(skill="gitFinish", args="reviewer: your-reviewer")`** — commit with `{{ issue.identifier }}: <…>` messages, push, open or update the PR against `dev`, request review from `@your-reviewer`, and post the PR link as a Linear comment on UUID `{{ issue.id }}`. End your response with the PR URL on its own line.

## Hard rules

- Do all work on the ticket branch — never push to `dev` directly.
- One ticket = one PR.
- If reviewer feedback is ambiguous or contradicts the ticket, leave a `gh pr comment` asking for clarification rather than guessing.
- Never check an acceptance-criteria box you did not actually implement and verify.
