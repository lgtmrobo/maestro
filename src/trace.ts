import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ToolDef } from "./backends/types.js";
import type { TokenUsage } from "./types.js";

/**
 * Per-run trace bundle.
 *
 * Captures what was sent to the agent and what came back, so a past run can be
 * inspected without re-rendering. Stored as one JSON file per run under
 * `${MAESTRO_DATA_DIR}/traces/<traceId>.json`. Two-phase write: `start()` lays
 * down the static fields (prompt, tool manifest, backend options) at dispatch
 * time; `attachSession()` adds the SDK session id on first event;
 * `finish()` writes the outcome.
 *
 * All disk operations are best-effort and never raise into the agent loop —
 * the writer is observability scaffolding, not a control surface.
 *
 * No retention policy implemented. Trace files accumulate forever. Add a
 * sweeper if the volume becomes a problem.
 */

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface TraceTicket {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
}

export interface TraceStartInput {
  laneName: string;
  backend: string;
  ticket: TraceTicket;
  attempt: number;
  startedAt: Date;
  renderedPrompt: string;
  customTools: ToolManifestEntry[];
  backendOptions: Record<string, unknown>;
}

export interface TraceResult {
  outcome: "normal" | "cancelled" | "error";
  stopReason: string | null;
  durationMs: number;
  tokenUsage: TokenUsage;
  errorMessage?: string;
}

export interface TraceRecord {
  traceId: string;
  sessionId: string | null;
  laneName: string;
  backend: string;
  ticket: TraceTicket;
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  renderedPrompt: string;
  customTools: ToolManifestEntry[];
  /**
   * Base tools (the SDK's ~30 built-ins like Bash/Read/Edit/...) are not
   * enumerated here — they come from `@codeany/open-agent-sdk.getAllBaseTools()`
   * at SDK version pinned in package.json. Inspect that to see the full list.
   */
  backendOptions: Record<string, unknown>;
  /**
   * Path to the SDK's own transcript file (tool calls, results, raw assistant
   * messages). Lives on the runner's home dir, computed from sessionId.
   * Will be ephemeral in containers unless the volume mounts cover it.
   */
  transcriptPath: string | null;
  result: TraceResult | null;
}

export class TraceWriter {
  private rootDir: string;
  private initPromise: Promise<unknown> | null = null;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  private async ensureRoot(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(this.rootDir, { recursive: true });
    }
    await this.initPromise;
  }

  private filePath(traceId: string): string {
    return join(this.rootDir, `${traceId}.json`);
  }

  /**
   * Write the initial trace record. Returns the trace id, or null if the
   * write failed (caller should log + continue without a trace).
   */
  async start(input: TraceStartInput): Promise<string | null> {
    const traceId = newTraceId(
      input.laneName,
      input.ticket.identifier,
      input.attempt,
    );
    const record: TraceRecord = {
      traceId,
      sessionId: null,
      laneName: input.laneName,
      backend: input.backend,
      ticket: input.ticket,
      attempt: input.attempt,
      startedAt: input.startedAt.toISOString(),
      completedAt: null,
      renderedPrompt: input.renderedPrompt,
      customTools: input.customTools,
      backendOptions: scrubBackendOptions(input.backendOptions),
      transcriptPath: null,
      result: null,
    };
    try {
      await this.ensureRoot();
      await atomicWriteJson(this.filePath(traceId), record);
      return traceId;
    } catch {
      return null;
    }
  }

  /**
   * Update an existing trace with the SDK's session id. No-op if the trace
   * does not exist on disk.
   */
  async attachSession(traceId: string, sessionId: string): Promise<void> {
    try {
      const current = await this.readRaw(traceId);
      if (!current) return;
      const next: TraceRecord = {
        ...current,
        sessionId,
        transcriptPath: defaultTranscriptPath(sessionId),
      };
      await atomicWriteJson(this.filePath(traceId), next);
    } catch {
      // best-effort
    }
  }

  /**
   * Write the final outcome onto an existing trace. No-op if the trace does
   * not exist on disk.
   */
  async finish(traceId: string, result: TraceResult): Promise<void> {
    try {
      const current = await this.readRaw(traceId);
      if (!current) return;
      const next: TraceRecord = {
        ...current,
        completedAt: new Date().toISOString(),
        result,
      };
      await atomicWriteJson(this.filePath(traceId), next);
    } catch {
      // best-effort
    }
  }

  async get(traceId: string): Promise<TraceRecord | null> {
    return this.readRaw(traceId);
  }

  /**
   * List traces, most recent first. Filters by lane and/or issueId if given.
   * Reads every file in the trace directory — fine for hundreds of runs, will
   * want an index past that.
   */
  async list(
    opts: {
      laneName?: string;
      issueId?: string;
      limit?: number;
    } = {},
  ): Promise<TraceRecord[]> {
    try {
      await this.ensureRoot();
      const entries = await readdir(this.rootDir);
      const files = entries.filter((f) => f.endsWith(".json"));
      const records: TraceRecord[] = [];
      for (const f of files) {
        const r = await this.readRaw(f.slice(0, -".json".length));
        if (!r) continue;
        if (opts.laneName && r.laneName !== opts.laneName) continue;
        if (opts.issueId && r.ticket.id !== opts.issueId) continue;
        records.push(r);
      }
      records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      if (opts.limit && opts.limit > 0) return records.slice(0, opts.limit);
      return records;
    } catch {
      return [];
    }
  }

  private async readRaw(traceId: string): Promise<TraceRecord | null> {
    try {
      const buf = await readFile(this.filePath(traceId), "utf-8");
      return JSON.parse(buf) as TraceRecord;
    } catch {
      return null;
    }
  }
}

function newTraceId(
  laneName: string,
  identifier: string,
  attempt: number,
): string {
  const safeLane = laneName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeId = identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeLane}-${safeId}-attempt${attempt}-${Date.now()}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

function defaultTranscriptPath(sessionId: string): string {
  return join(
    homedir(),
    ".open-agent-sdk",
    "sessions",
    sessionId,
    "transcript.json",
  );
}

/**
 * Strip well-known secret fields out of the per-run backendOptions block
 * before persisting it. `apiKey` is the obvious one (it's the gateway key for
 * open-agent backends). Mirrors the spirit of buildAgentEnv but at the
 * field-name level since backendOptions is a free-form record.
 */
function scrubBackendOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (/key|secret|token|password|passwd/i.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Best-effort: convert a Maestro ToolDef list into the serializable trace
 * shape. Zod-shape inputSchemas are converted to JSON Schema if Zod is
 * loadable; anything else is recorded as-is.
 */
export async function serializeCustomTools(
  tools: ToolDef[],
): Promise<ToolManifestEntry[]> {
  let z: any = null;
  try {
    ({ z } = await import("zod"));
  } catch {
    // zod not available; fall through
  }
  return tools.map((t) => {
    let inputSchema: unknown = t.inputSchema;
    if (z && isZodShape(t.inputSchema)) {
      try {
        inputSchema = z.toJSONSchema(z.object(t.inputSchema));
      } catch {
        // keep raw
      }
    }
    return {
      name: t.name,
      description: t.description,
      inputSchema,
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
