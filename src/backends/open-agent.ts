import type {
  AgentBackend,
  BackendRunOptions,
  NormalizedEvent,
  ToolDef,
} from "./types.js";
import { emptyTokenUsage } from "../types.js";
import { registerMaestroSkills } from "../skills/index.js";

/**
 * Open Agent SDK backend. Uses `query()` from `@codeany/open-agent-sdk`, which
 * runs the full agent loop in-process and supports both Anthropic-messages and
 * OpenAI-completions APIs (anything OpenAI-compatible via baseURL — OpenRouter,
 * LiteLLM, Vercel AI Gateway, OpenAI, DeepSeek, Qwen, Mistral, local Ollama).
 *
 * Built-in tools (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/etc) are
 * provided by the SDK via `getAllBaseTools()`. Lane-specific tools (e.g.
 * `linear_graphql`) are appended via `defineTool` using raw JSON Schema —
 * NOT via the SDK's Zod-based `tool()` helper, because Maestro uses Zod 4 and
 * the SDK uses Zod 3 internally, which causes `keyValidator._parse is not a
 * function` at runtime. Going through JSON Schema sidesteps the mismatch.
 *
 * Dynamically imported so this file's cost is not paid when the backend is unused.
 */
export class OpenAgentBackend implements AgentBackend {
  readonly kind = "open-agent" as const;

  async *run(opts: BackendRunOptions): AsyncIterable<NormalizedEvent> {
    let sdk: any;
    try {
      sdk = await import("@codeany/open-agent-sdk");
    } catch (err: any) {
      yield {
        kind: "error",
        message: `Failed to import @codeany/open-agent-sdk: ${err.message}`,
      };
      return;
    }

    const { query, defineTool, getAllBaseTools } = sdk;

    // Register Maestro skills against the SDK's global skill registry. The
    // built-in `Skill` tool (auto-included in getAllBaseTools) becomes
    // enabled once any skill is registered and surfaces the catalog to the
    // agent via system-reminder. Idempotent across runs.
    await registerMaestroSkills();

    // Translate Maestro ToolDef[] → SDK ToolDefinition[] using raw JSON Schema.
    //
    // We deliberately avoid the SDK's `tool()` / `createSdkMcpServer()` helpers
    // because they internally use the SDK's bundled Zod 3 instance, which is
    // not API-compatible with Maestro's Zod 4 schemas (causes
    // `keyValidator._parse is not a function` at tool-call time). Going via
    // JSON Schema sidesteps the version mismatch entirely.
    let mergedTools: unknown[] | undefined;
    if (opts.tools && opts.tools.length > 0) {
      const { z } = await import("zod");
      const customTools = opts.tools.map((t) =>
        buildOpenAgentTool(t, defineTool, z),
      );
      mergedTools = [...getAllBaseTools(), ...customTools];
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });

    // Strip null/undefined backend options — SDK chokes on null for fields
    // expecting array | string | absent.
    const cleanBackendOptions = Object.fromEntries(
      Object.entries(opts.backendOptions).filter(
        ([, v]) => v !== null && v !== undefined,
      ),
    );

    const queryOptions: Record<string, unknown> = {
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
      abortController: ac,
      env: opts.env ?? (process.env as Record<string, string>),
      ...cleanBackendOptions,
      ...(mergedTools && { tools: mergedTools }),
      ...(opts.resumeSessionId && { resume: opts.resumeSessionId }),
    };

    let q: AsyncIterable<unknown>;
    try {
      q = query({ prompt: opts.prompt, options: queryOptions });
    } catch (err: any) {
      opts.abortSignal.removeEventListener("abort", onAbort);
      yield { kind: "error", message: `query() threw: ${err.message}` };
      return;
    }

    try {
      for await (const msg of q as AsyncIterable<any>) {
        const event = translateOpenAgentMessage(msg);
        if (event) yield event;
      }
    } catch (err: any) {
      yield { kind: "error", message: `stream error: ${err.message}` };
    } finally {
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
  }
}

function buildOpenAgentTool(t: ToolDef, defineToolFn: any, z: any): any {
  const inputSchema = zodShapeToJsonSchema(t.inputSchema, z);

  return defineToolFn({
    name: t.name,
    description: t.description,
    inputSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // The SDK's defineTool expects `call` to return either a plain string
    // OR `{ data: string, is_error?: boolean }` — NOT a full ToolResult
    // shape. The defineTool wrapper extracts `data` and constructs the
    // tool_result envelope itself; returning the envelope here makes the
    // SDK read `result.data` as undefined and ship `content: null` to the
    // model, which the Anthropic API rejects with a 400 — bubbling up as
    // stop_reason=error on the next turn.
    async call(input: any) {
      const result = await t.handler(input);
      return {
        data: result.output,
        is_error: !result.ok,
      };
    },
  });
}

function isZodShape(s: unknown): s is Record<string, unknown> {
  return (
    s !== null &&
    typeof s === "object" &&
    Object.values(s as Record<string, unknown>).every(
      (v) => v !== null && typeof v === "object" && "_def" in (v as object),
    )
  );
}

/**
 * Convert a Maestro ToolDef.inputSchema (a Zod 4 shape — Record<string, ZodType>)
 * into a JSON Schema object suitable for the SDK's ToolDefinition.inputSchema.
 * If the input isn't recognizable as a Zod shape, fall back to a permissive
 * single-field "input" schema so tools still register.
 */
function zodShapeToJsonSchema(
  schema: unknown,
  z: any,
): { type: "object"; properties: Record<string, any>; required?: string[] } {
  if (isZodShape(schema)) {
    try {
      const obj = z.object(schema);
      const json = z.toJSONSchema(obj) as any;
      // Zod 4's toJSONSchema returns a Draft 2020-12 JSON Schema. We only need
      // type/properties/required for the SDK's ToolInputSchema shape.
      return {
        type: "object",
        properties: json.properties ?? {},
        ...(Array.isArray(json.required) ? { required: json.required } : {}),
      };
    } catch {
      // Fall through to permissive default
    }
  }
  return {
    type: "object",
    properties: { input: { description: "Arbitrary input payload" } },
  };
}

function translateOpenAgentMessage(msg: any): NormalizedEvent | null {
  if (!msg || typeof msg !== "object") return null;
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && typeof msg.session_id === "string") {
        return { kind: "session_start", sessionId: msg.session_id };
      }
      if (msg.subtype === "rate_limit") {
        const retryAfterMs =
          typeof msg.retry_after_ms === "number" ? msg.retry_after_ms : 60_000;
        return { kind: "rate_limit", retryAfterMs };
      }
      return { kind: "system", subtype: msg.subtype ?? "unknown", data: msg };
    }
    case "assistant": {
      const text = msg.message?.content?.find?.(
        (c: any) => c?.type === "text",
      )?.text;
      if (typeof text === "string") {
        return { kind: "assistant_text", text };
      }
      return { kind: "system", subtype: "assistant", data: msg };
    }
    case "tool_result": {
      const r = msg.result ?? {};
      return {
        kind: "tool_result",
        ok: !r.is_error,
        output:
          typeof r.output === "string" ? r.output : JSON.stringify(r.output),
      };
    }
    case "result": {
      // Treat as failure only for explicit error signals. Many real-world
      // runs (especially via OpenRouter) end without `subtype === "success"`
      // but with all work completed — e.g. `stop_reason: "error"` or
      // `subtype: undefined` after the agent finished its tool sequence.
      // Reporting those as failures triggers spurious retries.
      const errorSubtypes = new Set([
        "error",
        "error_max_turns",
        "error_during_execution",
        "error_max_budget_usd",
      ]);
      const isExplicitError =
        msg.is_error === true ||
        (typeof msg.subtype === "string" && errorSubtypes.has(msg.subtype)) ||
        msg.stop_reason === "error";
      const success = !isExplicitError;
      const stopReason = String(msg.stop_reason ?? msg.subtype ?? "unknown");
      // One-shot debug log so future failures are easier to triage. Only fires
      // when the result frame looks unusual (no `success` subtype and no
      // explicit error either) — keeps normal runs quiet.
      if (msg.subtype !== "success" && !isExplicitError) {
        // eslint-disable-next-line no-console
        console.error(
          `[open-agent] non-canonical result frame: subtype=${msg.subtype} stop_reason=${msg.stop_reason} is_error=${msg.is_error}`,
        );
      }
      if (msg.usage) {
        const u = msg.usage;
        const usage = {
          ...emptyTokenUsage(),
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: msg.total_cost_usd ?? 0,
        };
        return {
          kind: "result",
          success,
          stopReason,
          ...({ _usage: usage } as any),
        };
      }
      return { kind: "result", success, stopReason };
    }
    default:
      return null;
  }
}

export const openAgentBackend = new OpenAgentBackend();
