import type { AgentBackend, BackendRunOptions, NormalizedEvent } from './types.js';

/**
 * Codex backend stub. The intent is to drive `codex` in app-server mode
 * (JSON-RPC over stdio per OpenAI's Symphony spec) and translate its events
 * into NormalizedEvent. Not yet implemented — the seam exists so we can drop
 * the impl in without touching the orchestrator.
 *
 * When implementing, study:
 *   - https://github.com/openai/symphony/blob/main/SPEC.md (sections 4 + 5)
 *   - The Elixir reference impl's `codex_app_server_client.ex`
 */
export class CodexBackend implements AgentBackend {
  readonly kind = 'codex' as const;

  // eslint-disable-next-line require-yield
  async *run(_opts: BackendRunOptions): AsyncIterable<NormalizedEvent> {
    yield {
      kind: 'error',
      message:
        'Codex backend is not yet implemented. Set agent.backend to "claude" in your workflow file, or implement src/backends/codex.ts.',
    };
  }
}

export const codexBackend = new CodexBackend();
