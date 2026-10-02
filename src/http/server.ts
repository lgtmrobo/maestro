import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { basicAuth } from "hono/basic-auth";
import type { Orchestrator } from "../orchestrator.js";
import type { Lane } from "../lane.js";
import type { Logger } from "../logger.js";
import { DASHBOARD_HTML } from "./dashboard.js";

interface LaneSnapshot {
  name: string;
  backend: string;
  maxConcurrent: number;
  requiredLabels: string[];
  completedCount: number;
  running: Array<{
    identifier: string;
    title: string;
    startedAt: string;
    lastEvent: string | null;
    tokenUsage: { totalTokens: number };
    traceId: string | null;
  }>;
  retries: Array<{
    identifier: string;
    title: string;
    attempt: number;
    scheduledAt: string;
    reason: string;
  }>;
}

function snapshotLane(lane: Lane): LaneSnapshot {
  return {
    name: lane.name,
    backend: lane.workflow.backend,
    maxConcurrent: lane.workflow.agent.maxConcurrent,
    requiredLabels: lane.workflow.tracker.labels,
    completedCount: lane.completedCount,
    running: lane.runningEntries.map((e) => ({
      identifier: e.identifier,
      title: e.issue.title,
      startedAt: e.startedAt.toISOString(),
      lastEvent: e.lastEvent,
      tokenUsage: { totalTokens: e.tokenUsage.totalTokens },
      traceId: e.traceId,
    })),
    retries: lane.retryEntries.map((r) => ({
      identifier: r.issue.identifier,
      title: r.issue.title,
      attempt: r.attempt,
      scheduledAt: r.scheduledAt.toISOString(),
      reason: r.reason,
    })),
  };
}

export class HttpServer {
  private orchestrator: Orchestrator;
  private logger: Logger;
  private port: number;
  private host: string;
  private server: ReturnType<typeof serve> | null = null;

  constructor(
    orchestrator: Orchestrator,
    logger: Logger,
    port: number,
    host: string,
  ) {
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.port = port;
    this.host = host;
  }

  start(): void {
    const app = new Hono();

    // Healthcheck must be unauthenticated so Fly / load balancers can probe.
    app.get("/healthz", (c) =>
      c.json({
        ok: true,
        ts: Date.now(),
        lanes: this.orchestrator.allLanes().length,
      }),
    );

    // Optional basic auth on every other route. Enabled only when both env
    // vars are present, so local dev (no creds set) stays frictionless.
    const authUser = process.env.BASIC_AUTH_USER;
    const authPass = process.env.BASIC_AUTH_PASSWORD;
    if (authUser && authPass) {
      app.use("*", basicAuth({ username: authUser, password: authPass }));
      this.logger.info({}, "HTTP server: basic auth enabled");
    } else {
      this.logger.warn(
        {},
        "HTTP server: basic auth DISABLED (set BASIC_AUTH_USER + BASIC_AUTH_PASSWORD to enable)",
      );
    }

    app.get("/", (c) => c.html(DASHBOARD_HTML));

    app.get("/api/state", (c) => {
      return c.json({
        lanes: this.orchestrator.allLanes().map(snapshotLane),
      });
    });

    app.get("/api/traces", async (c) => {
      const tw = this.orchestrator.traceWriter;
      if (!tw) return c.json({ traces: [] });
      const laneName = c.req.query("lane") ?? undefined;
      const issueId = c.req.query("issueId") ?? undefined;
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 50;
      // By default the list is "past runs" — only finished records appear.
      // In-flight runs already show in the live lane snapshot, so including
      // them here would double-list them. Pass `?include=running` to override.
      const includeRunning = c.req.query("include") === "running";
      const all = await tw.list({ laneName, issueId });
      const filtered = includeRunning
        ? all
        : all.filter((r) => r.result !== null);
      const records = limit > 0 ? filtered.slice(0, limit) : filtered;
      // Strip the heavy renderedPrompt + toolManifest from the list response —
      // the detail endpoint returns those. Keeps the list cheap.
      const summaries = records.map((r) => ({
        traceId: r.traceId,
        sessionId: r.sessionId,
        laneName: r.laneName,
        backend: r.backend,
        ticket: r.ticket,
        attempt: r.attempt,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        outcome: r.result?.outcome ?? null,
        stopReason: r.result?.stopReason ?? null,
        durationMs: r.result?.durationMs ?? null,
        totalTokens: r.result?.tokenUsage.totalTokens ?? null,
      }));
      return c.json({ traces: summaries });
    });

    app.get("/api/trace/:traceId", async (c) => {
      const tw = this.orchestrator.traceWriter;
      if (!tw) return c.json({ error: "tracing disabled" }, 404);
      const traceId = c.req.param("traceId");
      const record = await tw.get(traceId);
      if (!record) return c.json({ error: "not found" }, 404);
      return c.json(record);
    });

    app.get("/api/events", (c) => {
      return streamSSE(c, async (stream) => {
        const send = async (event: string, data: unknown) => {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        };
        await send("hello", { ts: Date.now() });

        const handlers: Array<[string, (...args: unknown[]) => void]> = [];
        const subscribe = (event: string) => {
          const handler = (...args: unknown[]) => {
            void send(event, args).catch(() => undefined);
          };
          this.orchestrator.on(event, handler);
          handlers.push([event, handler]);
        };
        subscribe("running:add");
        subscribe("running:remove");
        subscribe("agent:event");
        subscribe("agent:tokens");
        subscribe("lane:tick:end");

        const interval = setInterval(() => {
          void send("heartbeat", { ts: Date.now() });
        }, 15_000);

        // Wait for client disconnect
        await new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });

        clearInterval(interval);
        for (const [event, handler] of handlers) {
          this.orchestrator.off(event, handler);
        }
      });
    });

    this.server = serve(
      { fetch: app.fetch, port: this.port, hostname: this.host },
      (info) => {
        this.logger.info(
          { port: info.port, host: this.host },
          "HTTP server started",
        );
      },
    );
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
