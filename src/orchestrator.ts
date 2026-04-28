import { Lane } from './lane.js';
import type { Logger } from './logger.js';
import type { WorkflowConfig } from './types.js';
import { buildToolsForWorkflow } from './tools.js';
import { EventEmitter } from 'node:events';

export interface OrchestratorOptions {
  workflows: WorkflowConfig[];
  logger: Logger;
  /** Extra env to pass through to spawned agents (e.g. GITHUB_TOKEN). */
  agentEnv?: Record<string, string>;
}

/** Top-level coordinator across N lanes. */
export class Orchestrator extends EventEmitter {
  private lanes = new Map<string, Lane>();
  private logger: Logger;

  constructor(opts: OrchestratorOptions) {
    super();
    this.logger = opts.logger;

    for (const workflow of opts.workflows) {
      const lane = new Lane({
        workflow,
        logger: opts.logger.child({ lane: workflow.name }),
        toolBuilder: () => {
          // Tools are built async, but we cache per-lane on first build.
          // For simplicity, build sync-ish via a shared cache populated below.
          return toolCache.get(workflow.name) ?? [];
        },
        agentEnv: () => opts.agentEnv ?? {},
      });

      // Forward lane events to top-level bus so HTTP server can subscribe once
      lane.on('tick:start', () => this.emit('lane:tick:start', workflow.name));
      lane.on('tick:end', (n) => this.emit('lane:tick:end', workflow.name, n));
      lane.on('running:add', (entry) => this.emit('running:add', entry));
      lane.on('running:remove', (id, result) => this.emit('running:remove', workflow.name, id, result));
      lane.on('agent:event', (id, name, detail) => this.emit('agent:event', workflow.name, id, name, detail));
      lane.on('agent:tokens', (id, usage) => this.emit('agent:tokens', workflow.name, id, usage));

      this.lanes.set(workflow.name, lane);
    }

    // Pre-build tools for each lane up front so the sync toolBuilder can return them.
    // We do this as a side-effect at construction; failures are logged but non-fatal.
    void this.preloadTools(opts.workflows);
  }

  private async preloadTools(workflows: WorkflowConfig[]): Promise<void> {
    for (const w of workflows) {
      try {
        const tools = await buildToolsForWorkflow(w.tracker);
        toolCache.set(w.name, tools);
      } catch (err: any) {
        this.logger.error({ err, lane: w.name }, 'Failed to build tools for lane');
      }
    }
  }

  laneNames(): string[] { return [...this.lanes.keys()]; }
  getLane(name: string): Lane | undefined { return this.lanes.get(name); }
  allLanes(): Lane[] { return [...this.lanes.values()]; }

  async start(): Promise<void> {
    this.logger.info({ lanes: this.laneNames() }, 'Orchestrator starting');
    for (const lane of this.lanes.values()) {
      await lane.start();
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Orchestrator stopping');
    for (const lane of this.lanes.values()) {
      await lane.stop();
    }
  }
}

const toolCache = new Map<string, Awaited<ReturnType<typeof buildToolsForWorkflow>>>();
