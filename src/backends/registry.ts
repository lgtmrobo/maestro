import type { AgentBackend } from './types.js';
import type { BackendKind } from '../types.js';
import { claudeBackend } from './claude.js';
import { codexBackend } from './codex.js';

const registry: Record<BackendKind, AgentBackend> = {
  claude: claudeBackend,
  codex: codexBackend,
};

export function getBackend(kind: BackendKind): AgentBackend {
  const backend = registry[kind];
  if (!backend) {
    throw new Error(`Unknown backend: ${kind}`);
  }
  return backend;
}
