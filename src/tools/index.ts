/**
 * Maestro tool factory.
 *
 * Each backend translates these to its native tool surface (Claude MCP,
 * open-agent SDK defineTool, etc) — see `src/backends/`.
 *
 * To add a new tool: drop a file in this directory exporting a builder
 * that returns `Promise<ToolDef>`, and wire it into the relevant tracker
 * branch in `buildToolsForWorkflow` below.
 */

import type { ToolDef } from "../backends/types.js";
import type { TrackerConfig } from "../types.js";
import {
  buildFigmaGetImageFillsTool,
  buildFigmaGetNodeTool,
  buildFigmaRenderNodeTool,
} from "./figma.js";
import { buildLinearGraphqlTool } from "./linear-graphql.js";
import { buildWriteTextTool, resolveWriteTextOptions } from "./write-text.js";

export async function buildToolsForWorkflow(
  tracker: TrackerConfig,
): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];

  if (tracker.kind === "linear") {
    tools.push(await buildLinearGraphqlTool(tracker.endpoint, tracker.apiKey));
  }

  // Figma tools are optional and only registered when the process has a
  // Figma personal access token. Lanes that never touch design files can
  // run without one; lanes that do (e.g. `frontend`) document the var.
  const figmaKey = process.env.FIGMA_API_KEY;
  if (figmaKey && figmaKey.length > 0) {
    tools.push(
      await buildFigmaGetNodeTool(figmaKey),
      await buildFigmaRenderNodeTool(figmaKey),
      await buildFigmaGetImageFillsTool(figmaKey),
    );
  }

  // write_text: cost-routing tool that dispatches boilerplate text-gen jobs
  // (commit messages, PR bodies, Linear comments) to a cheap model via the
  // same OpenAI-completions gateway the lane already uses. Activated when
  // WRITE_TEXT_API_KEY or CONCENTRATE_API_KEY is present.
  const writeTextOpts = resolveWriteTextOptions();
  if (writeTextOpts) {
    tools.push(await buildWriteTextTool(writeTextOpts));
  }

  return tools;
}
