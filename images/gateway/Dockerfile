FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    corepack enable && \
    pnpm add -g openclaw@2026.4.2 && \
    OPENCLAW_PACKAGE_ROOT="$(pnpm root -g)/openclaw" && \
    (cd "$OPENCLAW_PACKAGE_ROOT" && node scripts/postinstall-bundled-plugins.mjs) && \
    mkdir -p /opt/openclaw-sdk && \
    ln -sf "$OPENCLAW_PACKAGE_ROOT/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js && \
    printf '#!/bin/sh\nexec /pnpm/openclaw "$@"\n' > /usr/local/bin/openclaw && \
    chmod 755 /usr/local/bin/openclaw && \
    useradd -m -s /bin/bash openclaw && \
    mkdir -p /home/openclaw/.openclaw/extensions /home/openclaw/workspace /run/sshd /root && \
    chown -R openclaw:openclaw /home/openclaw && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true

COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin
