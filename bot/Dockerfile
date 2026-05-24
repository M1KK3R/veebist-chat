# Bot service that bridges Chatwoot webhooks → Claude CLI.
# Runs as UID 1001 so the mounted ~/.claude{,.json} files (owned by
# claudeuser on the host, also UID 1001) are readable.
#
# Debian (glibc) base — the mounted claude ELF binary is built against
# glibc; running it on musl/alpine fails with a cryptic "not found".
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 app \
    && useradd -u 1001 -g 1001 -m -s /bin/bash app

WORKDIR /app
COPY --chown=app:app . ./

USER app

# The host mounts /home/claudeuser/.local/bin/claude (symlink target lives
# under /home/claudeuser/.local/share/claude) into /home/app/bin/claude,
# matching the kusimusi pattern. Bot calls plain `claude`, so put it on PATH.
ENV PATH=/home/app/bin:/usr/local/bin:/usr/bin:/bin

EXPOSE 3500

CMD ["node", "index.js"]
