# Runs the DevAgent dashboard. Project scripts execute inside this container (not on your host) when you mount
# only the repositories you want the agent to touch. For per-command isolation use AGENT_SANDBOX_MODE=docker on a host with Docker.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 agent
WORKDIR /app
COPY --chown=agent:agent package.json package-lock.json ./
COPY --chown=agent:agent src ./src
COPY --chown=agent:agent ui ./ui
USER agent
ENV AGENT_DATA_DIR=/data AGENT_ALLOWED_DIRS=/projects AGENT_PORT=4317
VOLUME ["/data", "/projects"]
EXPOSE 4317
# The server binds to loopback by design; publish with: docker run -p 127.0.0.1:4317:4317 ... and set host via config if needed.
CMD ["node", "src/cli.js", "serve"]
