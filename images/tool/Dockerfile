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
    useradd -m -s /bin/bash sandbox && \
    mkdir -p /workspace /run/sshd && \
    chown sandbox:sandbox /workspace && \
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true
