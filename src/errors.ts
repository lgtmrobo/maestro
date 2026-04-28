export class MaestroError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MAESTRO_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ConfigError extends MaestroError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

export class TrackerError extends MaestroError {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message, 'TRACKER_ERROR');
    this.httpStatus = httpStatus;
  }
}

export class AgentError extends MaestroError {
  constructor(message: string) {
    super(message, 'AGENT_ERROR');
  }
}

export class WorkspaceError extends MaestroError {
  constructor(message: string) {
    super(message, 'WORKSPACE_ERROR');
  }
}
