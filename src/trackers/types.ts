import type { Issue } from '../types.js';

/**
 * Tracker abstraction. Adapters return normalized `Issue` records and accept
 * stable issue ids for state-mutation operations.
 */
export interface Tracker {
  /** Issues that are currently candidates for dispatch (in active states). */
  fetchCandidateIssues(): Promise<Issue[]>;

  /** Used for reconciliation: re-fetch a known set of issues by id. */
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;

  /** Append a comment to an issue. */
  createComment(issueId: string, body: string): Promise<void>;

  /** Move an issue to a tracker state by name. */
  updateIssueState(issueId: string, stateName: string): Promise<void>;
}
