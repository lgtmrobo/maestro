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
  // Linear OAuth (actor=app) credentials. Only required when `apiKey` is a
  // `lin_oauth_*` access token; ignored for personal `lin_api_*` keys.
  refreshToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const workspaceSchema = z.object({
  rootDir: z.string(),
  repo: z
    .object({
      url: z.string(),
      branch: z.string().optional(),
    })
    .optional(),
});

const pollingSchema = z.object({
  intervalMs: z.number().default(15_000),
});

const agentSchema = z.object({
  maxConcurrent: z.number().default(2),
  maxTurns: z.number().default(150),
  maxRetryBackoffMs: z.number().default(300_000),
  retryOnNormalExit: z.boolean().default(false),
  // State to move the issue to after a successful run. Must be in
  // tracker.terminalStates so the next poll won't pick it back up.
  completionState: z.string().default("Done"),
  // Optional state to move the issue to on dispatch (e.g. "In Progress"),
  // for observability. If unset, the issue stays in its current state
  // while the agent runs. Must be in tracker.activeStates so the running
  // entry's own filter doesn't push it back into the candidate pool.
  inProgressState: z.string().optional(),
});

const backendOptionsSchema = z.object({
  model: z.string().nullable().default(null),
  permissionMode: z.string().default("bypassPermissions"),
  allowedTools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).nullable().default(null),
  systemPrompt: z.string().nullable().default(null),
  turnTimeoutMs: z.number().default(3_600_000),
  // open-agent backend: route to any OpenAI-compatible or Anthropic-messages endpoint
  apiType: z.enum(["anthropic-messages", "openai-completions"]).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  // Codex-specific (future)
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
    completionState: "Done",
  }),
  backend: z.enum(["claude", "codex", "open-agent"]).default("claude"),
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
 * Resolve env-var references in string values. Two forms supported:
 *
 *   1. Whole-string `$VAR` — the entire string is replaced by process.env[VAR].
 *      Used historically for things like `apiKey: $LINEAR_API_KEY`.
 *
 *   2. Substring `${VAR}` — interpolated into the surrounding string.
 *      Used for partial paths like `rootDir: ${MAESTRO_DATA_DIR}/services`,
 *      so the same workflow file works locally (~/maestro-workspaces) and in
 *      the production container (/data/workspaces) by toggling the env var.
 *
 * In both forms the variable must be set, otherwise a ConfigError is thrown
 * at load time (fail-fast > runtime surprises).
 *
 * Recursively descends into arrays and objects.
 */
function resolveEnvVarsDeep<T>(value: T): T {
  if (typeof value === "string") {
    // Whole-string $VAR (no braces, must be the entire string).
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      const varName = value.slice(1);
      const resolved = process.env[varName];
      if (resolved === undefined) {
        throw new ConfigError(`Environment variable "${varName}" is not set`);
      }
      return resolved as unknown as T;
    }
    // Substring ${VAR} interpolation anywhere in the string.
    if (value.includes("${")) {
      const interpolated = value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_match, varName: string) => {
          const resolved = process.env[varName];
          if (resolved === undefined) {
            throw new ConfigError(
              `Environment variable "${varName}" referenced in "${value}" is not set`,
            );
          }
          return resolved;
        },
      );
      return interpolated as unknown as T;
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
    workspace: {
      rootDir: expandHome(frontmatter.workspace.rootDir),
      ...(frontmatter.workspace.repo && { repo: frontmatter.workspace.repo }),
    },
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
