import type {
  SkillDefinition,
  SkillContentBlock,
} from "@codeany/open-agent-sdk";

const PROMPT = `# gitFinish — commit, push, PR, Linear comment

Use this once implementation is complete and any acceptance-criteria boxes
are synced.

## 1. Commit

Stage and commit. Message MUST start with the ticket id:

\`\`\`sh
git add -A
git commit -m "<TICKET-ID>: <concise description in imperative mood>"
\`\`\`

Multiple commits are fine. Each one starts with the ticket id.

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

- **First-pass (no PR exists yet):**
  \`\`\`sh
  gh pr create --base <base-branch> --head <branch> \\
    --title "<TICKET-ID>: <issue title>" \\
    --body "$(cat <<'EOF'
  ## Summary
  <1-3 bullets describing what changed>

  ## Test plan
  - [ ] <how to verify this works>

  Closes [<TICKET-ID>](<issue url>)
  EOF
  )"
  \`\`\`
  \`<base-branch>\` is whatever the workflow targets (typically \`dev\`).

- **Re-run (PR exists):** the push you just did has updated it. Do NOT open
  a new PR. Optionally add \`gh pr comment <number> --body "<what changed>"\`
  to summarize the latest revision.

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
    "Commit, push, open OR update a PR, and post the PR link as a comment on the Linear issue. Handles first-pass vs re-run automatically.",
  whenToUse:
    "Once implementation is complete and all satisfied acceptance-criteria boxes have been synced via acceptanceSync. Run once per dispatch at the end.",
  aliases: ["finish", "ship"],
  allowedTools: ["Bash", "Read", "Grep", "Glob", "linear_graphql"],
  userInvocable: true,
  context: "inline",
  async getPrompt(args: string): Promise<SkillContentBlock[]> {
    const extra = args.trim() ? `\n\n## Caller args\n\n${args.trim()}` : "";
    return [{ type: "text", text: PROMPT + extra }];
  },
};
