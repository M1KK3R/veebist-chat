# Bot service that bridges Chatwoot webhooks → Claude/Codex CLI.
# Runs as UID 1001 so the mounted host files (claudeuser, UID 1001) are readable.
# Debian (glibc) base — required for the Claude ELF + Codex MUSL binary.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 app \
    && useradd -u 1001 -g 1001 -m -s /bin/bash app

WORKDIR /app
COPY --chown=app:app package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=app:app . ./

# Host mounts:
#   /home/claudeuser/.local/bin/claude → /home/app/bin/claude
#   /home/claudeuser/.npm-global/lib/node_modules/@openai/codex → /opt/codex
# Codex's bin/codex.js shebang is `node`, so an in-image symlink is enough.
USER root
RUN mkdir -p /opt/codex && ln -sf /opt/codex/bin/codex.js /usr/local/bin/codex
USER app

ENV PATH=/home/app/bin:/usr/local/bin:/usr/bin:/bin

EXPOSE 3500

CMD ["node", "index.js"]
