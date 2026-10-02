import type { ToolDef } from "../backends/types.js";

/**
 * Raw GraphQL pass-through to the Linear API. The team API key is bound at
 * build time, so the agent only supplies the query/mutation and variables.
 *
 * Used by skills (`acceptanceSync`, `gitFinish`) and ad-hoc agent reasoning
 * for issue mutations: description edits, state moves, comments.
 *
 * NOTE: the schema shape uses Zod 4 objects so the Claude backend can pass
 * them straight to the SDK's `tool(...)` helper. The open-agent backend
 * translates to JSON Schema at registration time (see
 * `src/backends/open-agent.ts`).
 */
export async function buildLinearGraphqlTool(
  endpoint: string,
  apiKey: string,
): Promise<ToolDef> {
  const { z } = await import("zod");
  return {
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
      // OAuth access tokens (lin_oauth_*) require the `Bearer` prefix; personal
      // API keys (lin_api_*) are sent bare. Mirrors LinearClient.authHeader.
      const authorization = apiKey.startsWith("lin_oauth_")
        ? `Bearer ${apiKey}`
        : apiKey;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
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
  };
}
