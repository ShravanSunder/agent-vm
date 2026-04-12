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
    useradd -m -s /bin/bash openclaw && \
    mkdir -p /home/openclaw/.openclaw /home/openclaw/workspace /run/sshd /root && \
    chown -R openclaw:openclaw /home/openclaw && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true && \
    mkdir -p /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin
