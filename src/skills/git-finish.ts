import type {
  SkillDefinition,
  SkillContentBlock,
} from "@codeany/open-agent-sdk";

const PROMPT = `# gitFinish — commit, push, PR, Linear comment

Use this once implementation is complete and any acceptance-criteria boxes
are synced.

## Cost-routing rule

Mechanical text writing (commit message, PR body) goes through the
\`write_text\` tool when it's available. \`write_text\` runs on a small fast
model so the main reasoning model doesn't spend output tokens on
boilerplate. Use the returned text verbatim — do not rewrite it.

If \`write_text\` is not in your tool list (env not configured), fall back to
the literal-text recipes in each step below.

## 1. Commit

Stage everything and prepare a change summary you'll hand to \`write_text\`:

\`\`\`sh
git add -A
git diff --cached --stat
\`\`\`

Then build the commit message via \`write_text\`:

\`\`\`
write_text(
  task="commit_message",
  context="Ticket: <TICKET-ID>. Brief change summary: <one sentence>. Files changed:\\n<output of git diff --cached --stat>"
)
\`\`\`

Take the returned string verbatim as your commit message:

\`\`\`sh
git commit -m "<text returned by write_text>"
\`\`\`

Multiple commits are fine — make one \`write_text\` call per commit if you
split things up. Each commit message starts with the ticket id.

**Fallback if \`write_text\` is unavailable:**

\`\`\`sh
git commit -m "<TICKET-ID>: <concise description in imperative mood>"
\`\`\`

## 2. Push

\`\`\`sh
git push -u origin HEAD
\`\`\`

## 3. PR handling

Re-run vs first-pass is determined by whether a PR existed when \`gitStart\`
ran. Recompute if needed:

\`\`\`sh
gh pr list --search "<TICKET-ID> in:title" --state open \\
  --json number,headRefName,url
\`\`\`

### First-pass (no PR exists yet)

Build the body via \`write_text\`. Pull a diff summary for context:

\`\`\`sh
git log --oneline <base-branch>..HEAD
git diff --stat <base-branch>...HEAD
\`\`\`

Then:

\`\`\`
write_text(
  task="pr_body",
  context="Ticket: <TICKET-ID> — <issue title>. Issue URL: <issue url>. Commits:\\n<git log output>\\n\\nDiff summary:\\n<git diff --stat output>\\n\\nWrite a PR body covering what changed and how to verify."
)
\`\`\`

Open the PR with the returned body verbatim:

\`\`\`sh
gh pr create --base <base-branch> --head <branch> \\
  --title "<TICKET-ID>: <issue title>" \\
  --body "$(cat <<'EOF'
<text returned by write_text>
EOF
)"
\`\`\`

\`<base-branch>\` is whatever the workflow targets (typically \`dev\`).

**Fallback if \`write_text\` is unavailable:** use a literal body like:

\`\`\`md
## Summary
<1-3 bullets describing what changed>

## Test plan
- [ ] <how to verify this works>

Closes [<TICKET-ID>](<issue url>)
\`\`\`

### Re-run (PR exists)

The push you just did has updated it. Do NOT open a new PR. Optionally
add a summary of the latest revision via \`write_text\`:

\`\`\`
write_text(
  task="freeform",
  context="Summarize this revision in one short paragraph for a PR comment. Changes: <list of what you addressed from the punch list>."
)
\`\`\`

Then post: \`gh pr comment <number> --body "<text>"\`.

## 4. Request review (if caller args include a reviewer)

If the caller args below include a line like \`reviewer: <github-handle>\`,
request a review from that user on the PR — both on first-pass and re-run.
A re-run intentionally re-requests review so the reviewer is re-notified
that the punch list has been addressed.

\`\`\`sh
gh pr edit <pr-number> --add-reviewer <github-handle>
\`\`\`

If no \`reviewer:\` line is present in caller args, skip this step.

## 5. Post the PR link to Linear

The Linear comment is short and templated — write it directly, no
\`write_text\` call needed:

Call \`linear_graphql\`:

\`\`\`graphql
mutation PostPRLink($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}
\`\`\`

Variables:
- First-pass: \`{ "issueId": "<uuid>", "body": "PR opened: <pr-url>" }\`
- Re-run:    \`{ "issueId": "<uuid>", "body": "PR updated: <pr-url>" }\`

## 6. Report

The final line of your response must be the PR URL — nothing else on that
line. The orchestrator parses it.`;

export const gitFinishSkill: SkillDefinition = {
  name: "gitFinish",
  description:
    "Commit, push, open OR update a PR, and post the PR link as a comment on the Linear issue. Handles first-pass vs re-run automatically. Routes commit-message and PR-body writing through `write_text` (cheap model) when available.",
  whenToUse:
    "Once implementation is complete and all satisfied acceptance-criteria boxes have been synced via acceptanceSync. Run once per dispatch at the end.",
  aliases: ["finish", "ship"],
  allowedTools: ["Bash", "Read", "Grep", "Glob", "linear_graphql", "write_text"],
  userInvocable: true,
  context: "inline",
  async getPrompt(args: string): Promise<SkillContentBlock[]> {
    const extra = args.trim() ? `\n\n## Caller args\n\n${args.trim()}` : "";
    return [{ type: "text", text: PROMPT + extra }];
  },
};
