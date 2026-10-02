import { Liquid } from 'liquidjs';
import type { Issue } from './types.js';

const engine = new Liquid({ strictFilters: false, strictVariables: false });

export interface IssueTemplateData {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: number | null;
  labels: string[];
  url: string | null;
  branch_name: string | null;
}

export function issueToTemplateData(issue: Issue): IssueTemplateData {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    state: issue.state,
    priority: issue.priority,
    labels: issue.labels,
    url: issue.url,
    branch_name: issue.branchName,
  };
}

export interface PromptContext {
  issue: IssueTemplateData;
  attempt: { number: number; error: string | null };
}

export class PromptBuilder {
  async render(template: string, ctx: PromptContext): Promise<string> {
    return engine.parseAndRender(template, ctx as unknown as Record<string, unknown>);
  }
}
