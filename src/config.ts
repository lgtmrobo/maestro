import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { WorkflowConfig, ServerConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas (per-workflow)
// ---------------------------------------------------------------------------

const trackerSchema = z.object({
  kind: z.enum(["linear", "github", "gitlab", "memory"]).default("linear"),
  endpoint: z.string().default("https://api.linear.app/graphql"),
  apiKey: z.string().default("demo"),
  teamKey: z.string(),
  activeStates: z.array(z.string()).default(["Todo", "In Progress"]),
  terminalStates: z
    .array(z.string())
    .default(["Done", "Canceled", "Cancelled", "Duplicate"]),
  assignee: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
});

const workspaceSchema = z.object({
  rootDir: z.string(),
});

const pollingSchema = z.object({
  intervalMs: z.number().default(15_000),
});

const agentSchema = z.object({
  maxConcurrent: z.number().default(2),
  maxTurns: z.number().default(150),
  maxRetryBackoffMs: z.number().default(300_000),
  retryOnNormalExit: z.boolean().default(false),
});

const backendOptionsSchema = z.object({
  model: z.string().nullable().default(null),
  permissionMode: z.string().default("bypassPermissions"),
  allowedTools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).nullable().default(null),
  systemPrompt: z.string().nullable().default(null),
  turnTimeoutMs: z.number().default(3_600_000),
  approvalPolicy: z.string().optional(),
  sandbox: z.string().optional(),
});

const workflowFrontmatterSchema = z.object({
  name: z.string(),
  tracker: trackerSchema,
  workspace: workspaceSchema,
  polling: pollingSchema.default({ intervalMs: 15_000 }),
  agent: agentSchema.default({
    maxConcurrent: 2,
    maxTurns: 150,
    maxRetryBackoffMs: 300_000,
    retryOnNormalExit: false,
  }),
  backend: z.enum(["claude", "codex"]).default("claude"),
  backendOptions: backendOptionsSchema.default({
    model: null,
    permissionMode: "bypassPermissions",
    allowedTools: null,
    disallowedTools: null,
    systemPrompt: null,
    turnTimeoutMs: 3_600_000,
  }),
});

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

/**
 * If a string starts with `$`, resolve it as a process.env lookup. Recursively
 * applies to nested string values in the config object.
 */
function resolveEnvVarsDeep<T>(value: T): T {
  if (typeof value === "string") {
    if (value.startsWith("$")) {
      const varName = value.slice(1);
      const resolved = process.env[varName];
      if (resolved === undefined) {
        throw new ConfigError(`Environment variable "${varName}" is not set`);
      }
      return resolved as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVarsDeep) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnvVarsDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

// ---------------------------------------------------------------------------
// Workflow file loader
// ---------------------------------------------------------------------------

export async function loadWorkflowFile(
  filePath: string,
): Promise<WorkflowConfig> {
  const absPath = resolve(filePath);
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch (err: any) {
    throw new ConfigError(
      `Cannot read workflow file ${absPath}: ${err.message}`,
    );
  }

  const parsed = matter(content);
  const promptTemplate = parsed.content.trim();

  // Default name from filename if not given
  const fileBaseName = basename(absPath, ".md");
  const rawData = { name: fileBaseName, ...parsed.data };

  const resolved = resolveEnvVarsDeep(rawData);

  let frontmatter: z.infer<typeof workflowFrontmatterSchema>;
  try {
    frontmatter = workflowFrontmatterSchema.parse(resolved);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      const messages = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new ConfigError(`Invalid workflow ${absPath}: ${messages}`);
    }
    throw err;
  }

  return {
    name: frontmatter.name,
    tracker: frontmatter.tracker,
    workspace: { rootDir: expandHome(frontmatter.workspace.rootDir) },
    polling: frontmatter.polling,
    agent: frontmatter.agent,
    backend: frontmatter.backend,
    backendOptions: frontmatter.backendOptions,
    promptTemplate,
  };
}

export async function loadWorkflowFiles(
  filePaths: string[],
): Promise<WorkflowConfig[]> {
  const workflows = await Promise.all(filePaths.map(loadWorkflowFile));

  // Validate unique names
  const seen = new Set<string>();
  for (const w of workflows) {
    if (seen.has(w.name)) {
      throw new ConfigError(
        `Duplicate workflow name "${w.name}" — each workflow must have a unique name in its frontmatter`,
      );
    }
    seen.add(w.name);
  }

  return workflows;
}

export interface MaestroRuntimeConfig {
  workflows: WorkflowConfig[];
  server: ServerConfig;
}
