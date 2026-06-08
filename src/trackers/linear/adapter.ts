import type { Tracker } from "../types.js";
import type { Issue, TrackerConfig } from "../../types.js";
import { LinearClient, type OAuthCredentials } from "./client.js";

function oauthFromConfig(config: TrackerConfig): OAuthCredentials | null {
  if (!config.apiKey.startsWith("lin_oauth_")) return null;
  const { refreshToken, clientId, clientSecret } = config;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      "Linear apiKey is a lin_oauth_* token but refreshToken / clientId / clientSecret are missing in tracker config",
    );
  }
  return { refreshToken, clientId, clientSecret };
}

export class LinearAdapter implements Tracker {
  private client: LinearClient;
  private activeStates: string[];

  constructor(config: TrackerConfig) {
    this.client = new LinearClient(
      config.endpoint,
      config.apiKey,
      config.teamKey,
      config.assignee,
      oauthFromConfig(config),
    );
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
