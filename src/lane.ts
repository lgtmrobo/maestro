import { AgentRunner } from "./agent-runner.js";
import { getBackend } from "./backends/registry.js";
import type { ToolDef } from "./backends/types.js";
import type { Tracker } from "./trackers/types.js";
import { createTracker } from "./trackers/factory.js";
import { WorkspaceManager } from "./workspace.js";
import type {
  Issue,
  RunningEntry,
  RetryEntry,
  TokenUsage,
  WorkerResult,
  WorkflowConfig,
} from "./types.js";
import type { Logger } from "./logger.js";
import { EventEmitter } from "node:events";

export interface LaneEvents {
  "lane:start": [];
  "lane:stop": [];
  "tick:start": [];
  "tick:end": [number];
  "agent:event": [string, string, string]; // issueId, eventName, detail
  "agent:tokens": [string, TokenUsage]; // issueId, usage
  "running:add": [RunningEntry];
  "running:remove": [string, WorkerResult];
  "completed:add": [string]; // issueId
  "retry:scheduled": [RetryEntry];
}

/**
 * One workflow lane: poll loop, dispatch, retries, reconciliation, all
 * scoped to the lane's tracker filters and agent slot pool.
 */
export class Lane extends EventEmitter {
  readonly workflow: WorkflowConfig;
  private tracker: Tracker;
  private workspace: WorkspaceManager;
  private logger: Logger;

  private running = new Map<string, RunningEntry>();
  private completed = new Set<string>();
  private retryQueue: RetryEntry[] = [];

  private tickTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private stopped = false;

  /** Callback for building tools exposed to the agent (lane-specific). */
  private toolBuilder: () => ToolDef[];

  /** Static env additions for the agent subprocess. */
  private agentEnv: () => Record<string, string>;

  constructor(opts: {
    workflow: WorkflowConfig;
    logger: Logger;
    toolBuilder: () => ToolDef[];
    agentEnv?: () => Record<string, string>;
  }) {
    super();
    this.workflow = opts.workflow;
    this.tracker = createTracker(opts.workflow.tracker);
    this.workspace = new WorkspaceManager(opts.workflow.workspace.rootDir);
    this.logger = opts.logger;
    this.toolBuilder = opts.toolBuilder;
    this.agentEnv = opts.agentEnv ?? (() => ({}));
  }

  // -------------------------------------------------------------------------
  // Public state accessors (used by HTTP server)
  // -------------------------------------------------------------------------

  get name(): string {
    return this.workflow.name;
  }
  get runningEntries(): RunningEntry[] {
    return [...this.running.values()];
  }
  get retryEntries(): RetryEntry[] {
    return [...this.retryQueue];
  }
  get completedCount(): number {
    return this.completed.size;
  }
  get availableSlots(): number {
    return Math.max(0, this.workflow.agent.maxConcurrent - this.running.size);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.logger.info({ lane: this.name }, "Lane started");
    this.emit("lane:start");
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const [, entry] of this.running) {
      this.logger.info(
        { lane: this.name, issueId: entry.issueId },
        "Aborting running agent on stop",
      );
    }
    this.emit("lane:stop");
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => this.tick(), delayMs);
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.tickInProgress || this.stopped) return;
    this.tickInProgress = true;
    this.emit("tick:start");

    try {
      // Phase 1: process due retries
      await this.processRetries();

      // Phase 2: reconcile running issues
      await this.reconcileRunning();

      // Phase 3: fetch candidates and dispatch
      let dispatched = 0;
      try {
        const candidates = await this.tracker.fetchCandidateIssues();

        // Re-opened tickets: clear them from completed so the filter lets them through.
        for (const issue of candidates) {
          if (this.completed.has(issue.id)) {
            this.completed.delete(issue.id);
            this.logger.info(
              {
                lane: this.name,
                issueId: issue.id,
                identifier: issue.identifier,
              },
              "Re-opened completed issue, cleared completion flag",
            );
          }
        }

        for (const issue of this.chooseIssues(candidates)) {
          try {
            await this.dispatchIssue(issue, 1);
            dispatched++;
          } catch (err: any) {
            this.logger.error(
              { err, issueId: issue.id },
              "Failed to dispatch issue",
            );
          }
        }
      } catch (err: any) {
        this.logger.error({ err }, "Failed to fetch candidates");
      }

      this.emit("tick:end", dispatched);
    } finally {
      this.tickInProgress = false;
      this.scheduleTick(this.workflow.polling.intervalMs);
    }
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  private chooseIssues(candidates: Issue[]): Issue[] {
    const requiredLabels = this.workflow.tracker.labels.map((l) =>
      l.toLowerCase(),
    );
    const activeStates = new Set(
      this.workflow.tracker.activeStates.map((s) => s.trim().toLowerCase()),
    );
    const terminalStates = new Set(
      this.workflow.tracker.terminalStates.map((s) => s.trim().toLowerCase()),
    );

    const eligible = candidates.filter((issue) => {
      if (!issue.id || !issue.identifier || !issue.title) return false;
      if (!issue.assignedToWorker) return false;

      // ALL configured labels must be present (case-insensitive)
      if (requiredLabels.length > 0) {
        const issueLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
        if (!requiredLabels.every((l) => issueLabels.has(l))) return false;
      }

      const normState = issue.state.trim().toLowerCase();
      if (!activeStates.has(normState)) return false;
      if (terminalStates.has(normState)) return false;

      // Skip blocked issues whose blockers aren't yet terminal
      if (
        issue.blockedBy.some(
          (b) => !terminalStates.has(b.state.trim().toLowerCase()),
        )
      ) {
        return false;
      }

      if (this.running.has(issue.id)) return false;
      if (this.completed.has(issue.id)) return false;

      return true;
    });

    eligible.sort((a, b) => {
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.createdAt !== b.createdAt)
        return a.createdAt < b.createdAt ? -1 : 1;
      return a.identifier.localeCompare(b.identifier);
    });

    return eligible.slice(0, this.availableSlots);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatchIssue(issue: Issue, attempt: number): Promise<void> {
    const workspacePath = await this.workspace.ensureWorkspace(
      issue.identifier,
    );
    const ac = new AbortController();

    const entry: RunningEntry = {
      laneName: this.name,
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      state: issue.state,
      startedAt: new Date(),
      attempt,
      sessionId: null,
      lastEvent: null,
      lastEventAt: null,
      lastActivityAt: new Date(),
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      },
    };
    this.running.set(issue.id, entry);
    this.emit("running:add", entry);
    this.logger.info(
      {
        lane: this.name,
        issueId: issue.id,
        identifier: issue.identifier,
        attempt,
      },
      "Issue dispatched",
    );

    const backend = getBackend(this.workflow.backend);

    const runner = new AgentRunner({
      workflow: this.workflow,
      backend,
      tracker: this.tracker,
      issue,
      workspacePath,
      attempt,
      abortController: ac,
      logger: this.logger,
      tools: this.toolBuilder(),
      env: { ...process.env, ...this.agentEnv() } as Record<string, string>,
      onEvent: (_lane, issueId, eventName, detail) => {
        const e = this.running.get(issueId);
        if (e) {
          e.lastEvent = eventName;
          e.lastEventAt = new Date();
          e.lastActivityAt = new Date();
        }
        this.emit("agent:event", issueId, eventName, detail);
      },
      onTokenUsage: (_lane, issueId, usage) => {
        const e = this.running.get(issueId);
        if (e) e.tokenUsage = usage;
        this.emit("agent:tokens", issueId, usage);
      },
      onSessionId: (_lane, issueId, sessionId) => {
        const e = this.running.get(issueId);
        if (e) e.sessionId = sessionId;
      },
    });

    runner
      .run()
      .then((result) => this.handleWorkerExit(issue, result))
      .catch((err) => {
        this.logger.error({ err, issueId: issue.id }, "Unhandled agent error");
        this.handleWorkerExit(issue, {
          kind: "error",
          issueId: issue.id,
          error: err instanceof Error ? err : new Error(String(err)),
          attempt,
          durationMs: 0,
        });
      });
  }

  private async handleWorkerExit(
    issue: Issue,
    result: WorkerResult,
  ): Promise<void> {
    const entry = this.running.get(issue.id);
    this.running.delete(issue.id);
    this.emit("running:remove", issue.id, result);

    switch (result.kind) {
      case "normal":
        this.completed.add(issue.id);
        this.emit("completed:add", issue.id);
        this.logger.info(
          {
            lane: this.name,
            issueId: issue.id,
            identifier: entry?.identifier,
            durationMs: result.durationMs,
            tokens: result.usage.totalTokens,
          },
          "Agent completed normally",
        );
        try {
          await this.tracker.createComment(
            issue.id,
            `Maestro completed run after ${result.turnsCompleted} turn(s).`,
          );
        } catch (err: any) {
          this.logger.error(
            { err, issueId: issue.id },
            "Failed to post completion comment",
          );
        }
        break;
      case "cancelled":
        this.logger.info(
          { lane: this.name, issueId: issue.id, reason: result.reason },
          "Agent cancelled",
        );
        break;
      case "error": {
        const attempt = result.attempt;
        const backoff = Math.min(
          2 ** attempt * 5_000,
          this.workflow.agent.maxRetryBackoffMs,
        );
        this.logger.warn(
          {
            lane: this.name,
            issueId: issue.id,
            err: result.error.message,
            attempt,
            backoffMs: backoff,
          },
          "Agent failed, scheduling retry",
        );
        const retry: RetryEntry = {
          laneName: this.name,
          issue,
          attempt: attempt + 1,
          scheduledAt: new Date(Date.now() + backoff),
          reason: result.error.message,
        };
        this.retryQueue.push(retry);
        this.emit("retry:scheduled", retry);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Retries + reconciliation
  // -------------------------------------------------------------------------

  private async processRetries(): Promise<void> {
    const now = Date.now();
    const due: RetryEntry[] = [];
    this.retryQueue = this.retryQueue.filter((r) => {
      if (r.scheduledAt.getTime() <= now) {
        due.push(r);
        return false;
      }
      return true;
    });
    for (const r of due) {
      if (this.availableSlots <= 0) {
        // Push back if no slots
        this.retryQueue.push({ ...r, scheduledAt: new Date(now + 5_000) });
        continue;
      }
      try {
        await this.dispatchIssue(r.issue, r.attempt);
      } catch (err: any) {
        this.logger.error(
          { err, issueId: r.issue.id },
          "Failed to dispatch retry",
        );
      }
    }
  }

  private async reconcileRunning(): Promise<void> {
    if (this.running.size === 0) return;
    const ids = [...this.running.keys()];
    let states: Map<string, string>;
    try {
      const issues = await this.tracker.fetchIssueStatesByIds(ids);
      states = new Map(issues.map((i) => [i.id, i.state]));
    } catch (err: any) {
      this.logger.warn({ err }, "Reconciliation fetch failed");
      return;
    }
    const terminalStates = new Set(
      this.workflow.tracker.terminalStates.map((s) => s.trim().toLowerCase()),
    );
    for (const [id, entry] of this.running) {
      const st = states.get(id);
      if (!st) continue;
      if (terminalStates.has(st.trim().toLowerCase()) && st !== entry.state) {
        this.logger.info(
          {
            lane: this.name,
            issueId: id,
            previous: entry.state,
            current: st,
          },
          "Issue moved to terminal state externally — agent will be allowed to finish",
        );
        // We don't force-cancel here; v0.1 keeps it simple. Future: ac.abort().
      }
    }
  }
}
