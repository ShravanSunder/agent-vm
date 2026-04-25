export interface RenderVmHostSystemDockerfileOptions {
	readonly gondolinPackageSpec: string;
	readonly zigVersion: string;
}

export interface RenderVmHostSystemZoneOptions {
	readonly zoneId: string;
}

export function renderVmHostSystemDockerfile(options: RenderVmHostSystemDockerfileOptions): string {
	return `# syntax=docker/dockerfile:1.7
# --------------------------------------------------------------------
# agent-vm vm-host-system - container host runtime image (multi-stage)
#
# Stage 1 (builder): pnpm install + build, then pnpm deploy --legacy.
# Stage 2 (runtime): COPY --from=builder the deployed directories.
# --------------------------------------------------------------------

FROM node:24-slim AS builder

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=\${PNPM_HOME}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV CI=true

RUN npm install -g pnpm@10

WORKDIR /build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile \\
    && pnpm build

RUN pnpm --filter @agent-vm/agent-vm --prod --legacy \\
      deploy /deploy-agent-vm \\
    && pnpm --filter @agent-vm/agent-vm-worker --prod --legacy \\
      deploy /deploy-agent-vm-worker

FROM docker.io/nestybox/ubuntu-noble-systemd-docker:latest

ARG DEBIAN_FRONTEND=noninteractive

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs=24.*

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      qemu-system-x86 qemu-utils e2fsprogs curl xz-utils cpio lz4 \\
    && apt-get clean \\
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ziglang.org/download/${options.zigVersion}/zig-x86_64-linux-${options.zigVersion}.tar.xz \\
    | tar -xJ -C /opt \\
    && ln -s /opt/zig-x86_64-linux-${options.zigVersion}/zig /usr/local/bin/zig

COPY --from=builder /deploy-agent-vm /opt/agent-vm
RUN printf '#!/bin/sh\\nexec node /opt/agent-vm/dist/cli/agent-vm-entrypoint.js "$@"\\n' > /usr/local/bin/agent-vm && \\
    chmod +x /usr/local/bin/agent-vm

RUN mkdir -p /etc/agent-vm/vm-images/gateways/worker/agent-vm-worker
COPY --from=builder /deploy-agent-vm-worker /etc/agent-vm/vm-images/gateways/worker/agent-vm-worker

RUN npm install -g pnpm@10

RUN pnpm dlx ${options.gondolinPackageSpec} image pull \\
    || echo "[WARN] Gondolin guest asset warmup failed; cold starts will be slow"

COPY config/ /etc/agent-vm/
COPY vm-images/gateways/worker/Dockerfile \\
     vm-images/gateways/worker/build-config.json \\
     /etc/agent-vm/vm-images/gateways/worker/

ARG GIT_SHA
RUN test -n "\${GIT_SHA}" \\
    || (echo "GIT_SHA build-arg required" >&2; exit 1) \\
    && printf '{\\n  "$comment": "System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha=local is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",\\n  "schemaVersion": 1,\\n  "os": "linux",\\n  "hostSystemType": "container",\\n  "gitSha": "%s"\\n}\\n' "\${GIT_SHA}" \\
    > /etc/agent-vm/systemCacheIdentifier.json

COPY vm-host-system/start.sh /usr/local/bin/start.sh
COPY vm-host-system/agent-vm-controller.service /etc/systemd/system/agent-vm-controller.service

RUN chmod +x /usr/local/bin/start.sh \\
    && mkdir -p /var/agent-vm/state /var/agent-vm/workspace /var/agent-vm/cache \\
    && systemctl enable agent-vm-controller.service

EXPOSE 18800
`;
}

export function renderVmHostSystemStartScript(options: RenderVmHostSystemZoneOptions): string {
	return `#!/bin/bash
set -euo pipefail

while IFS= read -r -d '' env_line; do
  env_key="\${env_line%%=*}"
  case "$env_key" in
    ''|PATH|HOME|PWD|SHLVL|_|OLDPWD) continue ;;
  esac
  export "$env_line"
done < /proc/1/environ

export HOME=/root
export PNPM_HOME=/usr/local/share/pnpm
export PATH="\${PNPM_HOME}:\${PATH}"

echo "[start] Waiting for Docker daemon (timeout 120s)..."
if ! timeout 120 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'; then
  echo "[FATAL] Docker daemon did not start within 120 seconds" >&2
  echo "[HINT] Check systemd: journalctl -u docker.service" >&2
  exit 1
fi

echo "[start] Running preflight checks..."
for cmd in zig mke2fs docker agent-vm cpio lz4 qemu-img qemu-system-x86_64; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[FATAL] Required command not found: $cmd" >&2
    exit 1
  fi
done

for required_var in OPENAI_API_KEY GITHUB_TOKEN; do
  if [ -z "\${!required_var:-}" ]; then
    echo "[FATAL] Required environment variable $required_var is not set" >&2
    exit 1
  fi
done
echo "[start] Preflight checks passed"

echo "[start] Checking Gondolin image cache..."
CACHE_JSON="$(agent-vm cache list --config /etc/agent-vm/system.json)"
CACHE_STATUS="$(
  node -e '
      const input = process.argv[1] ?? "";
    try {
      const data = JSON.parse(input);
      const gatewayHit = data.gateways.worker.some((entry) => entry.current) ? "yes" : "no";
      console.log(gatewayHit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`[FATAL] Failed to parse agent-vm cache list JSON: \${message}\`);
      console.error(\`[FATAL] First 200 chars: \${input.slice(0, 200)}\`);
      process.exit(1);
    }
  ' "$CACHE_JSON"
)"
read -r GATEWAY_CACHE_HIT <<< "$CACHE_STATUS"

if [ "$GATEWAY_CACHE_HIT" = "yes" ]; then
  echo "[start] cache hit for gateway image; skipping docker build and agent-vm build"
else
  echo "[start] cache miss; building OCI gateway image..."
  docker build \\
    -t agent-vm-gateway:local \\
    -f /etc/agent-vm/vm-images/gateways/worker/Dockerfile \\
    /etc/agent-vm/vm-images/gateways/worker/

  echo "[start] Building Gondolin VM assets into /var/agent-vm/cache (EFS)..."
  agent-vm build --config /etc/agent-vm/system.json
fi

echo "[start] Starting controller..."
exec agent-vm controller start --config /etc/agent-vm/system.json --zone ${options.zoneId}
`;
}

export function renderVmHostSystemSystemdUnit(): string {
	return `[Unit]
Description=agent-vm controller startup
Requires=docker.service
After=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

export function renderVmHostSystemReadme(options: RenderVmHostSystemZoneOptions): string {
	return `# vm-host-system

\`vm-host-system/\` contains the outer runtime image and boot plumbing for the container host that runs agent-vm.

It is separate from \`vm-images/\`: those are inner Gondolin VM recipes. This folder is the host system that starts Docker, checks the shared cache, builds the nested gateway OCI image on cache miss, and launches the controller for zone \`${options.zoneId}\`.

Regenerate these files with:

\`\`\`bash
agent-vm init ${options.zoneId} --type worker --preset container-x86 --overwrite
\`\`\`
`;
}
