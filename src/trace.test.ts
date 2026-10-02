import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TraceWriter,
  serializeCustomTools,
  type TraceStartInput,
  type TraceResult,
} from "./trace.js";
import { emptyTokenUsage } from "./types.js";
import type { ToolDef } from "./backends/types.js";

async function newTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "maestro-trace-"));
}

function sampleStart(
  overrides: Partial<TraceStartInput> = {},
): TraceStartInput {
  return {
    laneName: "frontend",
    backend: "open-agent",
    ticket: { id: "uuid-1", identifier: "ENG-1", title: "Test", url: null },
    attempt: 1,
    startedAt: new Date("2026-05-22T00:00:00Z"),
    renderedPrompt: "Hello world",
    customTools: [
      { name: "linear_graphql", description: "raw graphql", inputSchema: {} },
    ],
    backendOptions: {
      apiType: "openai-completions",
      baseURL: "https://example.com",
      apiKey: "secret-value",
      model: "anthropic/claude-sonnet-4-6",
    },
    ...overrides,
  };
}

describe("TraceWriter", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(async () => {
    dir = await newTempDir();
    writer = new TraceWriter(dir);
  });

  it("start() writes a trace file and returns a non-null id", async () => {
    const id = await writer.start(sampleStart());
    expect(id).not.toBeNull();
    const raw = await readFile(join(dir, `${id}.json`), "utf-8");
    const record = JSON.parse(raw);
    expect(record.traceId).toBe(id);
    expect(record.laneName).toBe("frontend");
    expect(record.ticket.identifier).toBe("ENG-1");
    expect(record.renderedPrompt).toBe("Hello world");
    expect(record.sessionId).toBeNull();
    expect(record.result).toBeNull();
  });

  it("redacts secret-looking fields in backendOptions before persisting", async () => {
    const id = await writer.start(sampleStart());
    const r = await writer.get(id!);
    expect(r!.backendOptions.apiKey).toBe("[redacted]");
    expect(r!.backendOptions.baseURL).toBe("https://example.com");
    expect(r!.backendOptions.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("attachSession() fills sessionId + computed transcriptPath", async () => {
    const id = await writer.start(sampleStart());
    await writer.attachSession(id!, "sess-abc");
    const r = await writer.get(id!);
    expect(r!.sessionId).toBe("sess-abc");
    expect(r!.transcriptPath).toMatch(
      /\.open-agent-sdk\/sessions\/sess-abc\/transcript\.json$/,
    );
  });

  it("finish() writes outcome + completedAt without mutating earlier fields", async () => {
    const id = await writer.start(sampleStart());
    const result: TraceResult = {
      outcome: "normal",
      stopReason: "end_turn",
      durationMs: 12_345,
      tokenUsage: { ...emptyTokenUsage(), totalTokens: 42 },
    };
    await writer.finish(id!, result);
    const r = await writer.get(id!);
    expect(r!.result).toEqual(result);
    expect(r!.completedAt).not.toBeNull();
    expect(r!.renderedPrompt).toBe("Hello world");
  });

  it("list() returns most-recent-first and respects filters", async () => {
    const a = await writer.start(
      sampleStart({
        ticket: {
          id: "uuid-A",
          identifier: "ENG-A",
          title: "A",
          url: null,
        },
        startedAt: new Date("2026-05-22T00:00:00Z"),
      }),
    );
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct ids
    const b = await writer.start(
      sampleStart({
        laneName: "backend",
        ticket: {
          id: "uuid-B",
          identifier: "ENG-B",
          title: "B",
          url: null,
        },
        startedAt: new Date("2026-05-23T00:00:00Z"),
      }),
    );
    const all = await writer.list();
    expect(all.map((r) => r.traceId)).toEqual([b, a]);

    const onlyFrontend = await writer.list({ laneName: "frontend" });
    expect(onlyFrontend.map((r) => r.traceId)).toEqual([a]);

    const onlyB = await writer.list({ issueId: "uuid-B" });
    expect(onlyB.map((r) => r.traceId)).toEqual([b]);

    const limit1 = await writer.list({ limit: 1 });
    expect(limit1).toHaveLength(1);
  });

  it("get() returns null for unknown trace id", async () => {
    expect(await writer.get("nope")).toBeNull();
  });

  it("attachSession() and finish() are no-ops on unknown trace id", async () => {
    await writer.attachSession("nope", "x");
    await writer.finish("nope", {
      outcome: "normal",
      stopReason: null,
      durationMs: 0,
      tokenUsage: emptyTokenUsage(),
    });
    // No crash, no file created.
    expect(await writer.list()).toEqual([]);
  });
});

describe("serializeCustomTools", () => {
  it("returns name + description + raw schema for non-Zod inputs", async () => {
    const tools: ToolDef[] = [
      {
        name: "noop",
        description: "does nothing",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true, output: "" }),
      },
    ];
    const out = await serializeCustomTools(tools);
    expect(out).toEqual([
      {
        name: "noop",
        description: "does nothing",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("converts Zod-shape inputs to JSON Schema", async () => {
    const { z } = await import("zod");
    const tools: ToolDef[] = [
      {
        name: "linear_graphql",
        description: "raw graphql",
        inputSchema: {
          query: z.string(),
          variables: z.record(z.string(), z.unknown()).optional(),
        },
        handler: async () => ({ ok: true, output: "" }),
      },
    ];
    const out = await serializeCustomTools(tools);
    expect(out[0].name).toBe("linear_graphql");
    expect((out[0].inputSchema as any).type).toBe("object");
    expect((out[0].inputSchema as any).properties.query).toBeDefined();
  });
});
