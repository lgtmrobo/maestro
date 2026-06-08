/**
 * Maestro skills: reusable playbooks extracted from workflow bodies.
 *
 * Skills are registered against `@codeany/open-agent-sdk`'s skill registry,
 * which exposes them to the agent via the built-in `Skill` tool. The agent
 * sees the catalog in a system-reminder and calls `Skill(skill="...")` to
 * inject the skill's prompt into the conversation.
 *
 * Skills only apply to lanes using `backend: open-agent`. The Claude Agent
 * SDK has its own separate skill mechanism — skills registered here are
 * invisible to it.
 *
 * To add a new skill: drop a file in this directory exporting a
 * `SkillDefinition` and add it to MAESTRO_SKILLS below.
 */

import type { SkillDefinition } from "@codeany/open-agent-sdk";
import { gitStartSkill } from "./git-start.js";
import { acceptanceSyncSkill } from "./acceptance-sync.js";
import { gitFinishSkill } from "./git-finish.js";

export const MAESTRO_SKILLS: SkillDefinition[] = [
  gitStartSkill,
  acceptanceSyncSkill,
  gitFinishSkill,
];

let registered = false;

/**
 * Register Maestro's skills against the open-agent SDK's global registry.
 * Idempotent — safe to call from each backend invocation.
 */
export async function registerMaestroSkills(): Promise<void> {
  if (registered) return;
  const { registerSkill } = await import("@codeany/open-agent-sdk");
  for (const skill of MAESTRO_SKILLS) {
    registerSkill(skill);
  }
  registered = true;
}
