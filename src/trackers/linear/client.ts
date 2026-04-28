import type { Issue, BlockerRef } from '../../types.js';
import { TrackerError } from '../../errors.js';

const ISSUE_PAGE_SIZE = 50;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  priority: unknown;
  branchName: string | null;
  url: string | null;
  assignee: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: { id: string; identifier: string; state: { name: string } };
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

interface IssuesQueryResult {
  issues: {
    nodes: LinearIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface ViewerResult {
  viewer: { id: string; name: string; email: string };
}

interface WorkflowStatesResult {
  workflowStates: { nodes: Array<{ id: string; name: string }> };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  state { name }
  priority
  branchName
  url
  assignee { id name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
  createdAt
  updatedAt
`;

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_IDS_QUERY = `
  query IssuesByIds($filter: IssueFilter) {
    issues(filter: $filter) { nodes { ${ISSUE_FIELDS} } }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }
`;

const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($filter: WorkflowStateFilter) {
    workflowStates(filter: $filter) { nodes { id name } }
  }
`;

const UPDATE_ISSUE_MUTATION = `
  mutation UpdateIssue($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
  }
`;

const VIEWER_QUERY = `
  query Viewer { viewer { id name email } }
`;

export class LinearClient {
  private endpoint: string;
  private apiKey: string;
  private teamKey: string;
  /** Resolved viewer id (or null if no assignee filter). */
  public assigneeId: string | null = null;
  /** Pending name filter — resolved on first fetch via viewer query. */
  private assigneeRaw: string | null;

  constructor(endpoint: string, apiKey: string, teamKey: string, assignee: string | null) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.teamKey = teamKey;
    this.assigneeRaw = assignee;
    this.assigneeId = assignee && assignee.toLowerCase() !== 'me' ? assignee : null;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new TrackerError(`Linear HTTP ${res.status}: ${res.statusText}`, res.status);
      }
      const json = (await res.json()) as GraphQLResponse<T>;
      if (json.errors?.length) {
        throw new TrackerError(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
      }
      if (!json.data) throw new TrackerError('Linear API returned no data');
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchViewer(): Promise<{ id: string; name: string; email: string }> {
    const data = await this.graphql<ViewerResult>(VIEWER_QUERY);
    return data.viewer;
  }

  /** Resolves "me" → viewer id once, lazily. */
  private async ensureAssigneeResolved(): Promise<void> {
    if (this.assigneeId !== null) return;
    if (this.assigneeRaw === null) return;
    if (this.assigneeRaw.toLowerCase() === 'me') {
      const viewer = await this.fetchViewer();
      this.assigneeId = viewer.id;
    } else {
      this.assigneeId = this.assigneeRaw;
    }
  }

  async fetchIssues(states: string[]): Promise<LinearIssueNode[]> {
    await this.ensureAssigneeResolved();
    const all: LinearIssueNode[] = [];
    let cursor: string | undefined;

    do {
      const filter: Record<string, unknown> = {
        team: { key: { eq: this.teamKey } },
        state: { name: { in: states } },
      };
      if (this.assigneeId) {
        filter.assignee = { id: { eq: this.assigneeId } };
      }

      const variables: Record<string, unknown> = { filter, first: ISSUE_PAGE_SIZE };
      if (cursor) variables.after = cursor;

      const data = await this.graphql<IssuesQueryResult>(ISSUES_QUERY, variables);
      all.push(...data.issues.nodes);
      cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor ?? undefined : undefined;
    } while (cursor);

    return all;
  }

  async fetchIssuesByIds(ids: string[]): Promise<LinearIssueNode[]> {
    if (ids.length === 0) return [];
    const data = await this.graphql<IssuesQueryResult>(ISSUES_BY_IDS_QUERY, {
      filter: { id: { in: ids } },
    });
    return data.issues.nodes;
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.graphql(CREATE_COMMENT_MUTATION, { issueId, body });
  }

  private async resolveStateId(stateName: string): Promise<string> {
    const data = await this.graphql<WorkflowStatesResult>(WORKFLOW_STATES_QUERY, {
      filter: { team: { key: { eq: this.teamKey } }, name: { eq: stateName } },
    });
    const node = data.workflowStates.nodes[0];
    if (!node) throw new TrackerError(`State "${stateName}" not found in team ${this.teamKey}`);
    return node.id;
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    const stateId = await this.resolveStateId(stateName);
    await this.graphql(UPDATE_ISSUE_MUTATION, { issueId, stateId });
  }

  normalizeIssue(node: LinearIssueNode): Issue {
    const labels = node.labels.nodes.map((l) => l.name.toLowerCase());

    const blockedBy: BlockerRef[] = node.inverseRelations.nodes
      .filter((r) => r.type === 'blocks')
      .map((r) => ({ id: r.issue.id, identifier: r.issue.identifier, state: r.issue.state.name }));

    const priority = typeof node.priority === 'number' ? node.priority : null;

    let assignedToWorker = false;
    if (this.assigneeId) {
      assignedToWorker = node.assignee?.id === this.assigneeId;
    } else if (this.assigneeRaw === null) {
      // No filter configured → treat all as assigned-to-worker
      assignedToWorker = true;
    }

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      state: node.state.name,
      priority,
      labels,
      blockedBy,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      assignedToWorker,
      url: node.url,
      branchName: node.branchName,
      assigneeId: node.assignee?.id ?? null,
    };
  }
}
