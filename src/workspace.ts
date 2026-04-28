import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceError } from './errors.js';

/** Sanitize an issue identifier into a safe directory name. */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class WorkspaceManager {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.rootDir, { recursive: true });
    } catch (err: any) {
      throw new WorkspaceError(`Failed to create workspace root ${this.rootDir}: ${err.message}`);
    }
  }

  workspacePath(identifier: string): string {
    return join(this.rootDir, sanitizeWorkspaceKey(identifier));
  }

  async ensureWorkspace(identifier: string): Promise<string> {
    await this.ensureRoot();
    const path = this.workspacePath(identifier);
    await mkdir(path, { recursive: true });
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
