import type { ToolDef } from "../backends/types.js";

/**
 * write_text — cost-routing tool that generates boilerplate-style structured
 * text via a small/cheap model on the same OpenAI-completions gateway the
 * main lane uses (concentrate.ai by default).
 *
 * The main agent loop runs the lane's primary model (typically Sonnet) for
 * reasoning, code edits, and tool choreography. Mechanical text-gen jobs
 * (commit messages, PR bodies, Linear comments) are routed here so they're
 * billed against a cheaper model without splitting the conversation.
 *
 * Activation:
 *   `WRITE_TEXT_API_KEY` (or `CONCENTRATE_API_KEY`) must be set. Otherwise the
 *   tool is not registered and skills must fall back to literal-text recipes.
 *
 * Env overrides:
 *   - `WRITE_TEXT_BASE_URL` — gateway base URL (default `https://api.concentrate.ai/v1`).
 *   - `WRITE_TEXT_API_KEY`  — gateway key (default reuses `CONCENTRATE_API_KEY`).
 *   - `WRITE_TEXT_MODEL`    — cheap model id (default `anthropic/claude-haiku-4-5`).
 */

interface WriteTextOptions {
  baseURL: string;
  apiKey: string;
  model: string;
}

type WriteTextTask =
  | "commit_message"
  | "pr_body"
  | "linear_comment"
  | "freeform";

const SYSTEM_PROMPTS: Record<WriteTextTask, string> = {
  commit_message:
    "You write single-line git commit messages in imperative mood. Output ONLY the message — no quotes, no markdown, no explanation. " +
    "When a ticket identifier is present in the context, the message MUST start with `<TICKET-ID>: ` followed by a concise description. " +
    "Stay under 72 characters total when possible. " +
    "Examples:\n" +
    "- ENG-522: implement hero section with photo grid\n" +
    "- ENG-525: render fast-frictionless 3-column grid",
  pr_body:
    "You write concise pull-request descriptions in GitHub-flavored Markdown. Output ONLY the body — no title, no surrounding text, no code fences around the whole thing. " +
    "Use these two sections and nothing else:\n\n" +
    "## Summary\n" +
    "- 1-3 bullets describing what the PR changes and why\n\n" +
    "## Test plan\n" +
    "- [ ] Bulleted checklist of how a reviewer verifies the change\n\n" +
    "If a `Closes <TICKET-ID>` or ticket URL is mentioned in context, append a `Closes [<TICKET-ID>](<url>)` line at the end. Keep the total under 200 words. No headings other than `## Summary` and `## Test plan`.",
  linear_comment:
    "You write single-line Linear comments summarizing a PR action. Output ONLY the comment — plain text, no markdown headers, no quotes. " +
    "Common patterns:\n" +
    "- `PR opened: <url>`\n" +
    "- `PR updated: <url>`\n" +
    "- `PR ready for review: <url>`\n" +
    "Include the URL verbatim when present in context. No trailing punctuation.",
  freeform:
    "You write structured text per the user's request. Output ONLY the requested text — no preamble, no explanation, no wrapping markdown unless the request explicitly asks for it.",
};

/**
 * Resolve write_text configuration from env. Returns `null` when no API key is
 * available — the caller should then skip registering the tool.
 */
export function resolveWriteTextOptions(
  env: NodeJS.ProcessEnv = process.env,
): WriteTextOptions | null {
  const apiKey = env.WRITE_TEXT_API_KEY ?? env.CONCENTRATE_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    return null;
  }
  return {
    baseURL: env.WRITE_TEXT_BASE_URL ?? "https://api.concentrate.ai/v1",
    apiKey,
    model: env.WRITE_TEXT_MODEL ?? "anthropic/claude-haiku-4-5",
  };
}

export async function buildWriteTextTool(
  opts: WriteTextOptions,
): Promise<ToolDef> {
  const { z } = await import("zod");
  return {
    name: "write_text",
    description:
      "Generate structured text (commit messages, PR bodies, Linear comments, freeform) via a fast cheap model. " +
      "Use this from skill steps that just need boilerplate text written from a diff or context summary — keeps the main reasoning model from spending output tokens on templated content. " +
      "Returns the generated text directly; use it verbatim.",
    inputSchema: {
      task: z
        .enum(["commit_message", "pr_body", "linear_comment", "freeform"])
        .describe(
          "What kind of text to write. Each task has tailored output rules — pick the closest match. Use `freeform` only when none fits and provide explicit instructions in `context`.",
        ),
      context: z
        .string()
        .min(1)
        .describe(
          "All input the writer needs: ticket id, diff summary, PR URL, prior conversation, etc. Be specific — the writer sees only this string.",
        ),
      constraints: z
        .string()
        .optional()
        .describe(
          "Optional extra instructions (e.g. 'mention ENG-522 in the bullet list'). Appended to the system prompt.",
        ),
    },
    handler: async (input: unknown) => {
      const { task, context, constraints } = input as {
        task: WriteTextTask;
        context: string;
        constraints?: string;
      };

      const systemPrompt = constraints
        ? `${SYSTEM_PROMPTS[task]}\n\nAdditional constraints from caller:\n${constraints}`
        : SYSTEM_PROMPTS[task];

      try {
        const res = await fetch(`${opts.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model: opts.model,
            // Tight cap — these tasks all produce short text. Going larger
            // just invites the model to add preambles.
            max_tokens: task === "pr_body" ? 1024 : 256,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: context },
            ],
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "<no body>");
          return {
            ok: false,
            output: `write_text gateway error ${res.status}: ${body.slice(0, 400)}`,
          };
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content;
        if (!text || typeof text !== "string") {
          return {
            ok: false,
            output: `write_text gateway returned no text — raw: ${JSON.stringify(data).slice(0, 400)}`,
          };
        }
        return { ok: true, output: text.trim() };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `write_text failed: ${message}` };
      }
    },
  };
}
