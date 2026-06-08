import type { SkillDefinition, SkillContentBlock } from "@codeany/open-agent-sdk";

const PROMPT = `# gitStart — branch + PR-review setup

Your cwd is a fresh clone of the target repo on the workflow's base branch
(e.g. \`dev\`). Do not \`cd\` — bash commands are stateless and won't persist
directory changes.

## 1. Identify the ticket

Use the ticket identifier (e.g. \`NEU-123\`) and title from the issue brief at
the top of this conversation.

## 2. Detect an existing PR for this ticket

\`\`\`sh
gh pr list --search "<TICKET-ID> in:title" --state open \\
  --json number,headRefName,baseRefName,url,title
\`\`\`

- **Zero matches** → first-pass path (step 4a).
- **Exactly one match** → re-run path (step 3 + 4b).
- **Multiple matches** → stop and post a \`gh pr comment\` on each asking
  which is canonical. Do not guess.

## 3. Re-run: build a punch list

For the matching PR (number = N):

\`\`\`sh
gh pr view N --comments
gh api repos/:owner/:repo/issues/N/comments --paginate
gh api repos/:owner/:repo/pulls/N/comments --paginate
gh pr checks N
\`\`\`

Rules:
1. **Bot comments count.** Treat \`lgtmrobo\`, \`hermes\`, \`coderabbit\`,
   \`vercel[bot]\`, etc. as equivalent to human reviewers.
2. **Only \`neuko-maestro\`'s own comments may be ignored** — they are your
   prior status updates.
3. **List every actionable item before doing anything else.** Anything
   matching \`- [ ]\`, "Please add/fix", "requesting fix", "missing X",
   "should X" goes on the list.
4. **Address every item.** Do not skip because "looked complete" or "minor".
5. **Never post "no changes required" if the list is non-empty.** Error state.
6. If an item is genuinely impossible or contradicts the ticket, post a
   \`gh pr comment\` asking for clarification rather than silently skipping.

## 4. Branch setup

- **4a. First-pass:**
  \`\`\`sh
  git checkout -b feat/<ticket-id-lower>-<short-kebab-slug>
  \`\`\`
  The branch MUST start with \`feat/<ticket-id-lower>-\`. The cwd is already
  on the latest base branch.

- **4b. Re-run:**
  \`\`\`sh
  git checkout <existing-branch>
  \`\`\`
  The branch is already fetched. Address every item from the punch list as
  you implement.

## 5. Report

Print the current branch name and, on re-run, the punch list you intend to
address. Then proceed with implementation in the main conversation.`;

export const gitStartSkill: SkillDefinition = {
  name: "gitStart",
  description:
    "Branch + PR-review setup for a Linear ticket. Detects an existing PR, walks every reviewer/bot comment into an actionable punch list, and sets up the working branch (re-run checkout OR first-pass feat/<id> branch).",
  whenToUse:
    "At the start of every ticket, before any implementation. Run once per dispatch.",
  aliases: ["start"],
  allowedTools: ["Bash", "Read", "Grep", "Glob"],
  userInvocable: true,
  context: "inline",
  async getPrompt(args: string): Promise<SkillContentBlock[]> {
    const extra = args.trim() ? `\n\n## Caller args\n\n${args.trim()}` : "";
    return [{ type: "text", text: PROMPT + extra }];
  },
};
