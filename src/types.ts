// Normalized issue, shared across trackers
export interface Issue {
  id: string;                   // tracker-internal stable id
  identifier: string;           // human-readable e.g. "NEU-130"
  title: string;
  description: string | null;
  state: string;                // tracker state name
  priority: number | null;
  labels: string[];             // lowercased
  blockedBy: BlockerRef[];
  createdAt: string;
  updatedAt: string;
  assignedToWorker: boolean;    // computed: matches workflow.assignee
  url: string | null;
  branchName: string | null;
  assigneeId: string | null;
}

export interface BlockerRef {
  id: string;
  identifier: string;
  state: string;
}

// Token usage aggregated per run
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export const emptyTokenUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
});

export const mergeUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  costUsd: a.costUsd + b.costUsd,
});

// Result of one agent run attempt
export type WorkerResult =
  | { kind: 'normal'; issueId: string; turnsCompleted: number; usage: TokenUsage; durationMs: number }
  | { kind: 'cancelled'; issueId: string; reason: string }
  | { kind: 'error'; issueId: string; error: Error; attempt: number; durationMs: number };

// Tracker config — one per workflow
export interface TrackerConfig {
  kind: 'linear' | 'github' | 'gitlab' | 'memory';
  endpoint: string;
  apiKey: string;
  teamKey: string;              // Linear team key (e.g. "NEU"), GitHub repo, etc
  activeStates: string[];
  terminalStates: string[];
  assignee: string | null;      // "me" or user id; null = no filter
  labels: string[];             // ALL must be present (lowercased compare)
}

// Workspace config (per-workflow)
export interface WorkspaceConfig {
  rootDir: string;
}

// Polling
export interface PollingConfig {
  intervalMs: number;
}

// Agent slot limits
export interface AgentLimitsConfig {
  maxConcurrent: number;        // per-lane cap
  maxTurns: number;
  maxRetryBackoffMs: number;
  retryOnNormalExit: boolean;
}

// Backend selection
export type BackendKind = 'claude' | 'codex';

export interface BackendOptions {
  // Claude-specific
  model?: string | null;
  permissionMode?: string;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  systemPrompt?: string | null;
  turnTimeoutMs?: number;
  // Codex-specific (future)
  approvalPolicy?: string;
  sandbox?: string;
}

// One workflow lane
export interface WorkflowConfig {
  name: string;                 // unique identifier, used in dashboard
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  polling: PollingConfig;
  agent: AgentLimitsConfig;
  backend: BackendKind;
  backendOptions: BackendOptions;
  promptTemplate: string;
}

// Server config (single, shared across lanes)
export interface ServerConfig {
  port: number;
  host: string;
}

// Top-level maestro config
export interface MaestroConfig {
  workflows: WorkflowConfig[];
  server: ServerConfig;
}

// Running entry per lane
export interface RunningEntry {
  laneName: string;
  issueId: string;
  identifier: string;
  issue: Issue;
  state: string;
  startedAt: Date;
  attempt: number;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastActivityAt: Date;
  tokenUsage: TokenUsage;
}

export interface RetryEntry {
  laneName: string;
  issue: Issue;
  attempt: number;
  scheduledAt: Date;
  reason: string;
}
