import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import type { Orchestrator } from './orchestrator.js';
import type { Lane } from './lane.js';
import type { Logger } from './logger.js';
import { DASHBOARD_HTML } from './dashboard-template.js';

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

  constructor(orchestrator: Orchestrator, logger: Logger, port: number, host: string) {
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.port = port;
    this.host = host;
  }

  start(): void {
    const app = new Hono();

    app.get('/', (c) => c.html(DASHBOARD_HTML));

    app.get('/api/state', (c) => {
      return c.json({
        lanes: this.orchestrator.allLanes().map(snapshotLane),
      });
    });

    app.get('/api/events', (c) => {
      return streamSSE(c, async (stream) => {
        const send = async (event: string, data: unknown) => {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        };
        await send('hello', { ts: Date.now() });

        const handlers: Array<[string, (...args: unknown[]) => void]> = [];
        const subscribe = (event: string) => {
          const handler = (...args: unknown[]) => {
            void send(event, args).catch(() => undefined);
          };
          this.orchestrator.on(event, handler);
          handlers.push([event, handler]);
        };
        subscribe('running:add');
        subscribe('running:remove');
        subscribe('agent:event');
        subscribe('agent:tokens');
        subscribe('lane:tick:end');

        const interval = setInterval(() => {
          void send('heartbeat', { ts: Date.now() });
        }, 15_000);

        // Wait for client disconnect
        await new Promise<void>((resolve) => {
          c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
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
        this.logger.info({ port: info.port, host: this.host }, 'HTTP server started');
      },
    );
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
