FROM node:24-slim

# Runtime auth must flow through controller HTTP mediation. Keep token env
# names, registry auth files, and build args out of this image so a future
# edit cannot accidentally turn a runtime secret into image state.

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      python3 && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g @openai/codex pnpm@10 && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \
    useradd -m -s /bin/bash coder && \
    mkdir -p /work/repos /work/tmp /work/cache /run/sshd /state /var/log && \
    touch /var/log/lastlog /var/log/faillog && \
    chown -R coder:coder /work /state && \
    (ln -sf /proc/self/fd /dev/fd 2>/dev/null || true)
