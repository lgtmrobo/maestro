import type { AgentBackend, ToolDef } from "./backends/types.js";
import type { Tracker } from "./trackers/types.js";
import { PromptBuilder, issueToTemplateData } from "./prompt-builder.js";
import type {
  Issue,
  WorkerResult,
  TokenUsage,
  WorkflowConfig,
} from "./types.js";
import { emptyTokenUsage, mergeUsage } from "./types.js";
import { AgentError } from "./errors.js";
import type { Logger } from "./logger.js";
import {
  TraceWriter,
  serializeCustomTools,
  type TraceResult,
} from "./trace.js";

export interface AgentRunnerOptions {
  workflow: WorkflowConfig;
  backend: AgentBackend;
  tracker: Tracker;
  issue: Issue;
  workspacePath: string;
  attempt: number;
  abortController: AbortController;
  logger: Logger;
  onEvent?: (
    laneName: string,
    issueId: string,
    eventName: string,
    detail: string,
  ) => void;
  onTokenUsage?: (laneName: string, issueId: string, usage: TokenUsage) => void;
  onSessionId?: (laneName: string, issueId: string, sessionId: string) => void;
  /** Called as soon as a trace bundle is written (right after prompt render). */
  onTraceId?: (laneName: string, issueId: string, traceId: string) => void;
  /** Tools to expose to the agent. Backend translates to its native tool surface. */
  tools?: ToolDef[];
  /** Base env to pass to the agent subprocess. */
  env?: Record<string, string>;
  /** Optional trace writer. When set, AgentRunner persists a per-run trace bundle. */
  traceWriter?: TraceWriter;
}

/** One agent execution run for one issue. */
export class AgentRunner {
  private options: AgentRunnerOptions;
  private promptBuilder = new PromptBuilder();

  constructor(options: AgentRunnerOptions) {
    this.options = options;
  }

  async run(): Promise<WorkerResult> {
    const { workflow, backend, issue, abortController, logger } = this.options;
    const startTime = Date.now();
    const startedAt = new Date();
    let totalUsage = emptyTokenUsage();
    let resultSuccess: boolean | null = null;
    let resultStopReason: string | null = null;

    // Forward declared so the finalize() helper at the bottom can reach them.
    let traceId: string | null = null;
    const finalize = async (r: WorkerResult): Promise<WorkerResult> => {
      if (this.options.traceWriter && traceId) {
        const traceResult: TraceResult = workerResultToTrace(
          r,
          totalUsage,
          resultStopReason,
        );
        await this.options.traceWriter.finish(traceId, traceResult);
      }
      return r;
    };

    if (abortController.signal.aborted) {
      return finalize({
        kind: "cancelled",
        issueId: issue.id,
        reason: "aborted before start",
      });
    }

    let prompt: string;
    try {
      prompt = await this.promptBuilder.render(workflow.promptTemplate, {
        issue: issueToTemplateData(issue),
        attempt: { number: this.options.attempt, error: null },
      });
    } catch (err: any) {
      return finalize({
        kind: "error",
        issueId: issue.id,
        error: new AgentError(`Prompt render failed: ${err.message}`),
        attempt: this.options.attempt,
        durationMs: Date.now() - startTime,
      });
    }

    // Persist the per-run trace bundle (best-effort, never blocks the run).
    if (this.options.traceWriter) {
      try {
        const customTools = await serializeCustomTools(
          this.options.tools ?? [],
        );
        traceId = await this.options.traceWriter.start({
          laneName: workflow.name,
          backend: workflow.backend,
          ticket: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
          },
          attempt: this.options.attempt,
          startedAt,
          renderedPrompt: prompt,
          customTools,
          backendOptions: workflow.backendOptions as Record<string, unknown>,
        });
        if (traceId) {
          this.options.onTraceId?.(workflow.name, issue.id, traceId);
        }
      } catch (err: any) {
        logger.warn(
          { err, issueId: issue.id },
          "Trace start failed (non-fatal)",
        );
      }
    }

    try {
      const events = backend.run({
        prompt,
        cwd: this.options.workspacePath,
        maxTurns: workflow.agent.maxTurns,
        abortSignal: abortController.signal,
        tools: this.options.tools,
        env: this.options.env,
        backendOptions: workflow.backendOptions as Record<string, unknown>,
      });

      for await (const ev of events) {
        this.options.onEvent?.(
          workflow.name,
          issue.id,
          ev.kind,
          JSON.stringify(ev).slice(0, 200),
        );

        switch (ev.kind) {
          case "session_start":
            this.options.onSessionId?.(workflow.name, issue.id, ev.sessionId);
            if (this.options.traceWriter && traceId) {
              void this.options.traceWriter.attachSession(
                traceId,
                ev.sessionId,
              );
            }
            break;
          case "usage":
            totalUsage = mergeUsage(totalUsage, ev.usage);
            this.options.onTokenUsage?.(workflow.name, issue.id, totalUsage);
            break;
          case "rate_limit":
            logger.warn(
              { retryAfterMs: ev.retryAfterMs, issueId: issue.id },
              "Agent rate-limited",
            );
            break;
          case "result":
            resultSuccess = ev.success;
            resultStopReason = ev.stopReason;
            // Some backends piggyback usage on result
            const piggy = (ev as any)._usage as TokenUsage | undefined;
            if (piggy) {
              totalUsage = mergeUsage(totalUsage, piggy);
              this.options.onTokenUsage?.(workflow.name, issue.id, totalUsage);
            }
            break;
          case "error":
            return finalize({
              kind: "error",
              issueId: issue.id,
              error: new AgentError(ev.message),
              attempt: this.options.attempt,
              durationMs: Date.now() - startTime,
            });
        }
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        return finalize({
          kind: "cancelled",
          issueId: issue.id,
          reason: err?.message ?? "aborted",
        });
      }
      return finalize({
        kind: "error",
        issueId: issue.id,
        error: err instanceof Error ? err : new AgentError(String(err)),
        attempt: this.options.attempt,
        durationMs: Date.now() - startTime,
      });
    }

    if (resultSuccess === false) {
      return finalize({
        kind: "error",
        issueId: issue.id,
        error: new AgentError(
          `Agent ended with stop_reason=${resultStopReason}`,
        ),
        attempt: this.options.attempt,
        durationMs: Date.now() - startTime,
      });
    }

    return finalize({
      kind: "normal",
      issueId: issue.id,
      turnsCompleted: 1,
      usage: totalUsage,
      durationMs: Date.now() - startTime,
    });
  }
}

function workerResultToTrace(
  r: WorkerResult,
  totalUsage: TokenUsage,
  resultStopReason: string | null,
): TraceResult {
  switch (r.kind) {
    case "normal":
      return {
        outcome: "normal",
        stopReason: resultStopReason,
        durationMs: r.durationMs,
        tokenUsage: r.usage,
      };
    case "cancelled":
      return {
        outcome: "cancelled",
        stopReason: r.reason,
        durationMs: 0,
        tokenUsage: totalUsage,
      };
    case "error":
      return {
        outcome: "error",
        stopReason: resultStopReason,
        durationMs: r.durationMs,
        tokenUsage: totalUsage,
        errorMessage: r.error.message,
      };
  }
}
