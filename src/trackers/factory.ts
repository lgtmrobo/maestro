import type { Tracker } from './types.js';
import type { TrackerConfig } from '../types.js';
import { LinearAdapter } from './linear/adapter.js';
import { ConfigError } from '../errors.js';

export function createTracker(config: TrackerConfig): Tracker {
  switch (config.kind) {
    case 'linear':
      return new LinearAdapter(config);
    case 'github':
    case 'gitlab':
    case 'memory':
      throw new ConfigError(`Tracker kind "${config.kind}" is not yet implemented in maestro v0.1`);
    default:
      throw new ConfigError(`Unknown tracker kind: ${config.kind}`);
  }
}
