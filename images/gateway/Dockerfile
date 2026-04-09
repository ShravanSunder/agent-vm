FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g openclaw@2026.4.2 && \
    useradd -m -s /bin/bash openclaw && \
    mkdir -p /home/openclaw/.openclaw /home/openclaw/workspace /run/sshd && \
    chown -R openclaw:openclaw /home/openclaw
