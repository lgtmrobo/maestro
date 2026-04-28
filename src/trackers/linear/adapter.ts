import type { Tracker } from '../types.js';
import type { Issue, TrackerConfig } from '../../types.js';
import { LinearClient } from './client.js';

export class LinearAdapter implements Tracker {
  private client: LinearClient;
  private activeStates: string[];

  constructor(config: TrackerConfig) {
    this.client = new LinearClient(config.endpoint, config.apiKey, config.teamKey, config.assignee);
    this.activeStates = config.activeStates;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const nodes = await this.client.fetchIssues(this.activeStates);
    return nodes.map((n) => this.client.normalizeIssue(n));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const nodes = await this.client.fetchIssuesByIds(ids);
    return nodes.map((n) => this.client.normalizeIssue(n));
  }

  async createComment(issueId: string, body: string): Promise<void> {
    return this.client.createComment(issueId, body);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    return this.client.updateIssueState(issueId, stateName);
  }
}
