import type { ToolDef } from "./backends/types.js";
import type { TrackerConfig } from "./types.js";

/**
 * Build the set of tools exposed to the agent for a given workflow. Today the
 * only built-in tool is a raw GraphQL pass-through for the configured tracker
 * (so the agent can update issue state, descriptions, comments, etc).
 *
 * NOTE: the schema shapes here are intentionally Zod objects so the Claude
 * backend can pass them straight to the SDK's `tool(...)` helper. Other
 * backends will need to translate at registration time.
 */
export async function buildToolsForWorkflow(
  tracker: TrackerConfig,
): Promise<ToolDef[]> {
  const { z } = await import("zod");

  if (tracker.kind === "linear") {
    const endpoint = tracker.endpoint;
    const apiKey = tracker.apiKey;
    return [
      {
        name: "linear_graphql",
        description:
          "Execute raw GraphQL against the Linear API. The team API key is pre-configured. Use this for issue mutations (description, state, comments).",
        inputSchema: {
          query: z.string().describe("The GraphQL query or mutation string"),
          variables: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional variables map"),
        },
        handler: async (input: unknown) => {
          const { query, variables } = input as {
            query: string;
            variables?: Record<string, unknown>;
          };
          try {
            const res = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: apiKey,
              },
              body: JSON.stringify({ query, variables }),
            });
            const data = await res.json();
            return { ok: res.ok, output: JSON.stringify(data, null, 2) };
          } catch (err: any) {
            return {
              ok: false,
              output: `linear_graphql failed: ${err.message}`,
            };
          }
        },
      },
    ];
  }

  // Other tracker kinds: no built-in tools yet
  return [];
}
