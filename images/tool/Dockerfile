FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    useradd -m -s /bin/bash sandbox && \
    mkdir -p /workspace /run/sshd && \
    chown sandbox:sandbox /workspace
