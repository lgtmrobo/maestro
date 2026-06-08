#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  const envContent = readFileSync(envFile, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key) process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
}

import { Command } from "commander";
import { join } from "node:path";
import { loadWorkflowFiles } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { HttpServer } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { TraceWriter } from "../src/trace.js";

const logger = createLogger({ component: "cli" });

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

const program = new Command();
program
  .name("maestro")
  .description("Agent-agnostic ticket orchestration")
  .version("0.1.0");

program
  .command("start")
  .description("Start the orchestrator with one or more workflow files")
  .requiredOption("-w, --workflows <files...>", "Path(s) to workflow .md files")
  .option("-p, --port <port>", "HTTP dashboard port", "4000")
  .option("-h, --host <host>", "HTTP dashboard host", "127.0.0.1")
  .action(async (opts: { workflows: string[]; port: string; host: string }) => {
    const workflows = await loadWorkflowFiles(opts.workflows);
    logger.info(
      { count: workflows.length, names: workflows.map((w) => w.name) },
      "Loaded workflows",
    );

    const agentEnv: Record<string, string> = {};
    if (process.env.GITHUB_TOKEN) {
      // Surface to spawned agents so `gh` uses the maestro bot identity
      agentEnv.GH_TOKEN = process.env.GITHUB_TOKEN;
      agentEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    }

    // Trace bundles live under ${MAESTRO_DATA_DIR}/traces if MAESTRO_DATA_DIR is
    // set; otherwise next to the cwd. Persists across restarts when on a volume.
    const tracesRoot = process.env.MAESTRO_DATA_DIR
      ? join(process.env.MAESTRO_DATA_DIR, "traces")
      : resolve(process.cwd(), ".maestro-traces");
    const traceWriter = new TraceWriter(tracesRoot);

    const orchestrator = new Orchestrator({
      workflows,
      logger,
      agentEnv,
      traceWriter,
    });
    const http = new HttpServer(
      orchestrator,
      logger,
      parseInt(opts.port, 10),
      opts.host,
    );

    http.start();
    await orchestrator.start();

    const shutdown = async (sig: string) => {
      logger.info({ sig }, "Shutdown signal received");
      http.stop();
      await orchestrator.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });

program
  .command("validate")
  .description("Parse and validate workflow files without starting")
  .requiredOption("-w, --workflows <files...>", "Path(s) to workflow .md files")
  .action(async (opts: { workflows: string[] }) => {
    const workflows = await loadWorkflowFiles(opts.workflows);
    for (const w of workflows) {
      console.log(
        `✓ ${w.name} (${w.tracker.kind}, backend=${w.backend}, labels=[${w.tracker.labels.join(", ")}])`,
      );
    }
  });

program.parseAsync().catch((err) => {
  logger.fatal({ err }, "CLI error");
  process.exit(1);
});
