import { mkdir, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceError } from "./errors.js";

const exec = promisify(execFile);

/** Sanitize an issue identifier into a safe directory name. */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface WorkspaceRepoConfig {
  url: string;
  branch?: string;
}

export class WorkspaceManager {
  private rootDir: string;
  private repo: WorkspaceRepoConfig | undefined;

  constructor(rootDir: string, repo?: WorkspaceRepoConfig) {
    this.rootDir = resolve(rootDir);
    this.repo = repo;
  }

  async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.rootDir, { recursive: true });
    } catch (err: any) {
      throw new WorkspaceError(
        `Failed to create workspace root ${this.rootDir}: ${err.message}`,
      );
    }
  }

  workspacePath(identifier: string): string {
    return join(this.rootDir, sanitizeWorkspaceKey(identifier));
  }

  /**
   * Ensure a workspace exists for the given identifier and return its path.
   *
   * When `repo` is configured, the workspace is a fresh git clone (on first
   * use) or a fetched + reset clone (on re-use). The remote `branch` is
   * checked out and reset to the latest origin/<branch> so re-runs always start
   * from a clean, up-to-date base.
   *
   * When `repo` is not configured, behavior is unchanged: just an empty dir.
   */
  async ensureWorkspace(identifier: string): Promise<string> {
    await this.ensureRoot();
    const path = this.workspacePath(identifier);

    if (!this.repo) {
      await mkdir(path, { recursive: true });
      return path;
    }

    const url = injectTokenIntoGitHubUrl(this.repo.url, process.env.GITHUB_TOKEN);
    const branch = this.repo.branch;

    const hasClone = await dirHasGitRepo(path);
    if (!hasClone) {
      // Fresh clone. Remove any stray files first so we get a clean checkout.
      await rm(path, { recursive: true, force: true });
      const args = ["clone"];
      if (branch) args.push("--branch", branch);
      args.push(url, path);
      try {
        await exec("git", args, { env: process.env });
      } catch (err: any) {
        throw new WorkspaceError(
          `git clone failed for ${this.repo.url}: ${stderr(err)}`,
        );
      }
    } else {
      // Existing clone — fetch and hard-reset to the upstream branch.
      try {
        await exec("git", ["fetch", "origin", "--prune"], {
          cwd: path,
          env: process.env,
        });
        if (branch) {
          await exec("git", ["checkout", branch], { cwd: path, env: process.env });
          await exec("git", ["reset", "--hard", `origin/${branch}`], {
            cwd: path,
            env: process.env,
          });
        }
      } catch (err: any) {
        throw new WorkspaceError(
          `git refresh failed in ${path}: ${stderr(err)}`,
        );
      }
    }

    return path;
  }

  async exists(identifier: string): Promise<boolean> {
    try {
      await stat(this.workspacePath(identifier));
      return true;
    } catch {
      return false;
    }
  }

  async remove(identifier: string): Promise<void> {
    const path = this.workspacePath(identifier);
    if (!(await this.exists(identifier))) return;
    await rm(path, { recursive: true, force: true });
  }
}

async function dirHasGitRepo(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, ".git"));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/**
 * If the URL is a github.com HTTPS URL and we have a GITHUB_TOKEN available,
 * embed it so `git clone` can authenticate non-interactively. For SSH URLs or
 * other hosts, leave the URL untouched and let git use the user's configured
 * credentials.
 */
function injectTokenIntoGitHubUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  const prefix = "https://github.com/";
  if (!url.startsWith(prefix)) return url;
  // x-access-token is the convention for GitHub PATs and App tokens.
  return `https://x-access-token:${token}@github.com/${url.slice(prefix.length)}`;
}

function stderr(err: any): string {
  if (err && typeof err === "object") {
    const msg = (err.stderr ?? err.message ?? String(err)) as string;
    return typeof msg === "string" ? msg.trim() : String(msg);
  }
  return String(err);
}
