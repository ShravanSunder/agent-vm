FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    npm install -g openclaw@2026.4.2 && \
    mkdir -p /opt/agent-vm-worker && \
    printf '%s\n' \
      '{' \
      '  "name": "agent-vm-worker-runtime",' \
      '  "private": true,' \
      '  "type": "module",' \
      '  "dependencies": {' \
      '    "@modelcontextprotocol/sdk": "^1.29.0",' \
      '    "@hono/node-server": "^1",' \
      '    "@hono/zod-validator": "^0.7.6",' \
      '    "@openai/codex-sdk": "^0.118.0",' \
      '    "cmd-ts": "^0.13.0",' \
      '    "execa": "^9.5.2",' \
      '    "hono": "^4",' \
      '    "zod": "^4",' \
      '    "zod-to-json-schema": "^3.24.1"' \
      '  }' \
      '}' > /opt/agent-vm-worker/package.json && \
    cd /opt/agent-vm-worker && npm install --omit=dev && cd / && \
    useradd -m -s /bin/bash openclaw && \
    mkdir -p /home/openclaw/.openclaw /home/openclaw/workspace /run/sshd /root && \
    chown -R openclaw:openclaw /home/openclaw && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true && \
    mkdir -p /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin /opt/agent-vm-worker/dist
