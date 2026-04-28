import type { TokenUsage } from '../types.js';

/**
 * Normalized event stream emitted by every backend. All backends translate
 * their native event shape into one of these so the orchestrator does not
 * need to know which agent is running.
 */
export type NormalizedEvent =
  | { kind: 'session_start'; sessionId: string }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'tool_result'; ok: boolean; output: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'rate_limit'; retryAfterMs: number }
  | { kind: 'result'; success: boolean; stopReason: string }
  | { kind: 'system'; subtype: string; data: Record<string, unknown> }
  | { kind: 'error'; message: string };

/**
 * Tool definition exposed to the agent. Each backend decides how to wire it
 * up (Claude → MCP server, Codex → function calling, etc).
 */
export interface ToolDef {
  name: string;
  description: string;
  // Shape is intentionally loose — backends are expected to know the schema
  // they receive (typically a Zod or JSON schema).
  inputSchema: unknown;
  handler: (input: unknown) => Promise<{ ok: boolean; output: string }>;
}

export interface BackendRunOptions {
  prompt: string;
  cwd: string;
  maxTurns: number;
  abortSignal: AbortSignal;
  tools?: ToolDef[];
  resumeSessionId?: string;
  env?: Record<string, string>;
  // Backend-specific options bag (model, permissionMode, etc)
  backendOptions: Record<string, unknown>;
}

export interface AgentBackend {
  /** Stable identifier (e.g. "claude", "codex"). */
  readonly kind: string;

  /**
   * Run one agent session. Returns an async iterable of normalized events.
   * The iterable terminates when the session completes (or errors). Throwing
   * is reserved for setup-time failures (e.g. SDK import error).
   */
  run(opts: BackendRunOptions): AsyncIterable<NormalizedEvent>;
}
