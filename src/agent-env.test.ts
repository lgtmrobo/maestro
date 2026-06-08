import { describe, it, expect } from "vitest";
import { buildAgentEnv } from "./agent-env.js";

describe("buildAgentEnv", () => {
  it("passes infrastructure env vars through unchanged", () => {
    const out = buildAgentEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      USER: "neuko",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
    });
    expect(out).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      USER: "neuko",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
    });
  });

  it("strips Maestro OAuth + gateway + dashboard secrets", () => {
    const out = buildAgentEnv({
      PATH: "/usr/bin",
      LINEAR_API_KEY: "lin_oauth_xxx",
      LINEAR_REFRESH_TOKEN: "lin_refresh_xxx",
      LINEAR_CLIENT_ID: "abc",
      LINEAR_CLIENT_SECRET: "def",
      CONCENTRATE_API_KEY: "conc_xxx",
      BASIC_AUTH_USER: "team",
      BASIC_AUTH_PASSWORD: "secret",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });

  it("strips anything matching SECRET / PASSWORD / PASSWD patterns", () => {
    const out = buildAgentEnv({
      PATH: "/usr/bin",
      MY_API_SECRET: "x",
      DB_PASSWORD: "x",
      LDAP_PASSWD: "x",
      OPENAI_API_KEY: "kept-by-design-no-pattern-match",
    });
    expect(out).toEqual({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "kept-by-design-no-pattern-match",
    });
  });

  it("ignores undefined values (Node's ProcessEnv shape)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      MAYBE_UNSET: undefined,
    };
    expect(buildAgentEnv(env)).toEqual({ PATH: "/usr/bin" });
  });

  it("layers the `extra` map on top so callers can add (or override) explicit vars", () => {
    const out = buildAgentEnv(
      { PATH: "/usr/bin", LINEAR_API_KEY: "should-be-stripped" },
      { GH_TOKEN: "ghp_xxx", GITHUB_TOKEN: "ghp_xxx" },
    );
    expect(out).toEqual({
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_xxx",
      GITHUB_TOKEN: "ghp_xxx",
    });
  });

  it("`extra` wins over hostEnv for the same key", () => {
    const out = buildAgentEnv(
      { PATH: "/usr/bin", FOO: "from-host" },
      { FOO: "from-extra" },
    );
    expect(out.FOO).toBe("from-extra");
  });
});
