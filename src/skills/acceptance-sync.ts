import type { SkillDefinition, SkillContentBlock } from "@codeany/open-agent-sdk";

const PROMPT = `# acceptanceSync — flip Linear acceptance-criteria checkboxes

Use this after you implement a verifiable piece of behavior whose acceptance
criterion lives as a \`- [ ]\` checkbox in the Linear issue description.

## Procedure

1. Fetch the current description via \`linear_graphql\`:
   \`\`\`graphql
   query GetIssue($id: String!) {
     issue(id: $id) { description }
   }
   \`\`\`
   Variables: \`{ "id": "<linear-issue-uuid-from-conversation>" }\`.

2. Identify boxes you have actually satisfied. Flip ONLY those:
   - \`- [ ]\` → \`- [x]\`
   - Preserve every other character verbatim (newlines, indentation,
     surrounding text).

3. Push the revised description back. Linear replaces the entire field:
   \`\`\`graphql
   mutation UpdateDescription($id: String!, $description: String!) {
     issueUpdate(id: $id, input: { description: $description }) { success }
   }
   \`\`\`

## Hard rules

- Never check a box you did not implement and verify.
- Never delete or reword non-checkbox content.
- If you flip multiple boxes, send one \`issueUpdate\` with the final
  description — not one mutation per box.`;

export const acceptanceSyncSkill: SkillDefinition = {
  name: "acceptanceSync",
  description:
    "Flip Linear acceptance-criteria checkboxes from `- [ ]` to `- [x]` for items you have actually implemented and verified. Updates the issue description via linear_graphql.",
  whenToUse:
    "After completing a behavior whose acceptance criterion is a checkbox in the Linear issue description. Can be called multiple times during a ticket.",
  aliases: ["sync", "ac"],
  allowedTools: ["linear_graphql"],
  userInvocable: true,
  context: "inline",
  async getPrompt(args: string): Promise<SkillContentBlock[]> {
    const extra = args.trim() ? `\n\n## Caller args\n\n${args.trim()}` : "";
    return [{ type: "text", text: PROMPT + extra }];
  },
};
