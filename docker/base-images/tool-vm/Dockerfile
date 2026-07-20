FROM node:24-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      git \
      curl \
      e2fsprogs \
      jq \
      ripgrep \
      fd-find \
      build-essential \
      file \
      less \
      micro \
      procps \
      rsync \
      tree \
      unzip \
      zip && \
    rm -f /etc/ssh/ssh_host_* && \
    rm -rf /var/lib/apt/lists/* && \
    update-ca-certificates

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

RUN \
    npm install -g pnpm@10.33.0 && \
    pnpm --version && \
    uv python install 3.13 --install-dir /opt/python --no-progress --compile-bytecode && \
    python_bin="$(find /opt/python -mindepth 3 -maxdepth 3 -type f -path '*/bin/python3.13' | head -n 1)" && \
    python_bindir="$(dirname "$python_bin")" && \
    ln -sfn "$python_bindir/python" /usr/local/bin/python && \
    ln -sfn "$python_bindir/python3" /usr/local/bin/python3 && \
    ln -sfn "$python_bindir/python3.13" /usr/local/bin/python3.13 && \
    ln -sfn "$python_bindir/pip" /usr/local/bin/pip && \
    ln -sfn "$python_bindir/pip3" /usr/local/bin/pip3 && \
    ln -sfn "$python_bindir/pip3.13" /usr/local/bin/pip3.13 && \
    python3 --version && \
    uv --version && \
    uvx --version && \
    rm -rf /root/.cache/uv && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    ln -sfn /proc/self/fd /dev/fd && \
    mkdir -p /work /scratch /run/sshd /var/log && \
    touch /var/log/lastlog /var/log/faillog

WORKDIR /work
