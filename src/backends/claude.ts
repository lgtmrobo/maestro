import type {
  AgentBackend,
  BackendRunOptions,
  NormalizedEvent,
  ToolDef,
} from "./types.js";
import { emptyTokenUsage } from "../types.js";

/**
 * Claude Code Agent SDK backend. Uses `query()` from
 * `@anthropic-ai/claude-agent-sdk` and translates its events into the
 * normalized stream.
 *
 * The SDK is dynamically imported so that test harnesses (or codebases that
 * don't install Claude) do not pay the import cost.
 */
export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;

  async *run(opts: BackendRunOptions): AsyncIterable<NormalizedEvent> {
    let sdk: any;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch (err: any) {
      yield {
        kind: "error",
        message: `Failed to import Claude SDK: ${err.message}`,
      };
      return;
    }

    const { query, createSdkMcpServer, tool } = sdk;

    // Translate ToolDef[] → MCP server (Claude's native tool surface)
    let mcpServers: Record<string, unknown> | undefined;
    if (opts.tools && opts.tools.length > 0) {
      // Lazy zod import — only needed when tools are passed
      const { z } = await import("zod");
      const sdkTools = opts.tools.map((t) => buildClaudeMcpTool(t, tool, z));
      mcpServers = {
        maestro: createSdkMcpServer({
          name: "maestro",
          version: "1.0.0",
          tools: sdkTools,
        }),
      };
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });

    // Strip null/undefined backend options — the SDK chokes on null values
    // for fields like allowedTools / systemPrompt where it expects array | string | absent.
    const cleanBackendOptions = Object.fromEntries(
      Object.entries(opts.backendOptions).filter(
        ([, v]) => v !== null && v !== undefined,
      ),
    );

    const queryOptions: Record<string, unknown> = {
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
      abortController: ac,
      env: opts.env ?? process.env,
      ...cleanBackendOptions,
      ...(mcpServers && { mcpServers }),
      ...(opts.resumeSessionId && { resume: opts.resumeSessionId }),
    };

    // permissionMode bypassPermissions also wants the dangerous flag
    if (queryOptions.permissionMode === "bypassPermissions") {
      queryOptions.allowDangerouslySkipPermissions = true;
    }

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
        const event = translateClaudeMessage(msg);
        if (event) yield event;
      }
    } catch (err: any) {
      yield { kind: "error", message: `stream error: ${err.message}` };
    } finally {
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
  }
}

function buildClaudeMcpTool(t: ToolDef, toolFn: any, z: any): any {
  // Many ToolDef.inputSchema values will already be a Zod shape; if it's a
  // plain object we wrap each property as z.unknown() to keep things working.
  const shape = isZodShape(t.inputSchema)
    ? t.inputSchema
    : { input: z.unknown() };

  return toolFn(t.name, t.description, shape, async (input: unknown) => {
    const result = await t.handler(input);
    return {
      content: [{ type: "text", text: result.output }],
      ...(result.ok ? {} : { isError: true }),
    };
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

function translateClaudeMessage(msg: any): NormalizedEvent | null {
  if (!msg || typeof msg !== "object") return null;
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && typeof msg.session_id === "string") {
        return { kind: "session_start", sessionId: msg.session_id };
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
    case "rate_limit_event": {
      const retryAfterMs =
        typeof msg.retry_after_ms === "number" ? msg.retry_after_ms : 60_000;
      return { kind: "rate_limit", retryAfterMs };
    }
    case "result": {
      const success = msg.is_error === false;
      const stopReason = String(msg.stop_reason ?? msg.subtype ?? "unknown");
      // Sometimes Claude returns usage/cost on the result frame
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
        // Emit usage right before result so the orchestrator captures both
        return {
          kind: "result",
          success,
          stopReason,
          /* usage piggybacked */ ...({ _usage: usage } as any),
        };
      }
      return { kind: "result", success, stopReason };
    }
    case "error": {
      return {
        kind: "error",
        message: String(msg.message ?? msg.error ?? "Unknown agent error"),
      };
    }
    default:
      return null;
  }
}

// Convenience: bare instance — most callers just want one
export const claudeBackend = new ClaudeBackend();
