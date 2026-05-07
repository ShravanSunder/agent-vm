FROM node:24-slim

# Runtime auth must flow through controller HTTP mediation. Keep token env
# names, registry auth files, and build args out of this image so a future
# edit cannot accidentally turn a runtime secret into image state.

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      gh \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    corepack enable && \
    corepack prepare pnpm@10.33.0 --activate && \
    pnpm add -g openclaw@2026.5.2 && \
    OPENCLAW_PACKAGE_ROOT="$(pnpm root -g)/openclaw" && \
    (cd "$OPENCLAW_PACKAGE_ROOT" && node scripts/postinstall-bundled-plugins.mjs) && \
    printf '%s\n' \
      '{' \
      '  "gateway": { "mode": "local", "auth": { "mode": "token" } },' \
      '  "plugins": {' \
      '    "load": { "paths": ["/home/openclaw/.openclaw/extensions", "/pnpm/global/5/node_modules/@openclaw"] },' \
      '    "allow": ["gondolin", "memory-core"],' \
      '    "slots": { "memory": "memory-core" },' \
      '    "entries": {' \
      '      "gondolin": { "enabled": true, "config": { "controllerUrl": "http://controller.vm.host:18800", "zoneId": "build" } },' \
      '      "memory-core": { "enabled": true }' \
      '    }' \
      '  }' \
      '}' > /tmp/openclaw-plugin-stage-config.json && \
    chmod 600 /tmp/openclaw-plugin-stage-config.json && \
    (OPENCLAW_CONFIG_PATH=/tmp/openclaw-plugin-stage-config.json openclaw doctor --fix --non-interactive || true) && \
    rm -f /tmp/openclaw-plugin-stage-config.json /tmp/openclaw-plugin-stage-config.json.bak && \
    mkdir -p /opt/openclaw-sdk && \
    ln -sf "$OPENCLAW_PACKAGE_ROOT/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js && \
    printf '#!/bin/sh\nexec /pnpm/openclaw "$@"\n' > /usr/local/bin/openclaw && \
    chmod 755 /usr/local/bin/openclaw && \
    useradd -m -s /bin/bash openclaw && \
    mkdir -p /home/openclaw/.openclaw/extensions /zone /run/sshd /root /work/tmp /work/cache /var/log && \
    touch /var/log/lastlog /var/log/faillog && \
    chown -R openclaw:openclaw /home/openclaw /work && \
    chown -R root:root /home/openclaw/.openclaw/extensions && \
    (ln -sfn /proc/self/fd /dev/fd 2>/dev/null || true)
