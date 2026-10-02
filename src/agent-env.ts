/**
 * Build the env that gets handed to a spawned agent run.
 *
 * Background: the agent has unrestricted `Bash` and `bypassPermissions` is on,
 * so anything in `process.env` is one prompt-injection away from being
 * `echo`-ed into a tool result or a PR description. Most of `process.env` is
 * benign (PATH, HOME, locale, etc.) but the orchestrator also holds OAuth
 * client secrets, refresh tokens, gateway keys, and dashboard auth that the
 * agent has no business seeing.
 *
 * Filter pattern: denylist by name (regex + explicit set). We deliberately do
 * not allowlist infrastructure env vars because agent runs need a long tail
 * of them (PATH, HOME, USER, SHELL, TMPDIR, NODE_*, locale, plus toolchain
 * envs like VIRTUAL_ENV, GOPATH, CARGO_HOME, etc.) and an allowlist would
 * make every new toolchain a config change.
 *
 * Explicitly stripped:
 *   - LINEAR_REFRESH_TOKEN / LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET — OAuth
 *     refresh creds. Agent never needs them; `linear_graphql` has the access
 *     token bound in its closure.
 *   - LINEAR_API_KEY — also unnecessary for the same reason. Belt + braces.
 *   - CONCENTRATE_API_KEY — gateway key. SDK reads from `backendOptions.apiKey`
 *     at workflow load, so the env passthrough is redundant.
 *   - BASIC_AUTH_* — dashboard auth.
 *   - Anything matching /SECRET/i, /PASSWORD/i, /PASSWD/i.
 *
 * Caller adds explicit business env (typically `GH_TOKEN`/`GITHUB_TOKEN`) via
 * the `extra` arg, which overrides anything filtered.
 */

const SENSITIVE_NAME_PATTERNS: RegExp[] = [
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
];

const EXPLICIT_DENY = new Set<string>([
  "LINEAR_API_KEY",
  "LINEAR_REFRESH_TOKEN",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "CONCENTRATE_API_KEY",
  "BASIC_AUTH_USER",
  "BASIC_AUTH_PASSWORD",
]);

export function buildAgentEnv(
  hostEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined) continue;
    if (EXPLICIT_DENY.has(k)) continue;
    if (SENSITIVE_NAME_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v;
  }
  return out;
}
