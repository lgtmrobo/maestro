FROM node:22-bookworm-slim

# git: needed by WorkspaceManager (clone-per-ticket).
# gh:  needed by spawned agents to create/inspect PRs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates curl gnupg tini \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack — matches the project's lockfile.
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

# Dependency layer (cached when only source changes).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source. .dockerignore keeps node_modules / .git / workspaces out.
COPY . .

# Hosted dashboard listens here. Fly maps this to 443 via http_service.
EXPOSE 4000

# Workflow paths and listen config are env-driven so fly.toml is the single
# source of truth. Override locally via `docker run -e ...`.
# MAESTRO_WORKFLOWS has no useful default — there is no production workflow
# checked in yet. fly.toml / `fly secrets set MAESTRO_WORKFLOWS=...` must set
# this before first deploy. If unset, Maestro fails fast with a "cannot read
# workflow file" error.
ENV MAESTRO_PORT="4000" \
    MAESTRO_HOST="0.0.0.0" \
    MAESTRO_DATA_DIR="/data/workspaces"

# tini handles signal forwarding so SIGTERM from fly cleanly stops Maestro.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "pnpm tsx bin/maestro.ts start -w $MAESTRO_WORKFLOWS -p $MAESTRO_PORT -h $MAESTRO_HOST"]
