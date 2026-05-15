FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      jq \
      python3 \
      ripgrep \
      fd-find \
      build-essential \
      less \
      tree \
      nano \
      vim-tiny && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    corepack enable && \
    corepack prepare pnpm@10.33.0 --activate && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    ln -sfn /proc/self/fd /dev/fd && \
    mkdir -p /work /run/sshd /var/log && \
    touch /var/log/lastlog /var/log/faillog

WORKDIR /work
