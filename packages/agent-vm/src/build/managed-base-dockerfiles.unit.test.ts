import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const managedBaseDockerfiles = [
	['openclaw-gateway', path.join('docker', 'base-images', 'openclaw-gateway', 'Dockerfile')],
	['tool-vm', path.join('docker', 'base-images', 'tool-vm', 'Dockerfile')],
	['worker-gateway', path.join('docker', 'base-images', 'worker-gateway', 'Dockerfile')],
] as const satisfies readonly (readonly [string, string])[];

describe('managed base Dockerfiles', () => {
	it.each(managedBaseDockerfiles)(
		'provides guest rootfs growth tooling in %s',
		async (_baseName: string, dockerfilePath: string) => {
			const dockerfile = await fs.readFile(path.join(process.cwd(), dockerfilePath), 'utf8');

			expect(dockerfile).toMatch(/^\s+e2fsprogs(?: \\| &&)/mu);
		},
	);

	it.each(managedBaseDockerfiles)(
		'provides Linux file descriptor compatibility in %s',
		async (_baseName: string, dockerfilePath: string) => {
			const dockerfile = await fs.readFile(path.join(process.cwd(), dockerfilePath), 'utf8');

			expect(dockerfile).toContain('ln -sfn /proc/self/fd /dev/fd');
		},
	);

	it('pins pnpm in the OpenClaw gateway base without baking OpenClaw runtime packages', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'openclaw-gateway', 'Dockerfile'),
			'utf8',
		);

		expect(dockerfile).toContain('npm install -g pnpm@10.33.0');
		expect(dockerfile).toContain('pnpm --version');
		expect(dockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(dockerfile).toContain('COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/');
		expect(dockerfile).toContain('uv python install 3.13 --install-dir /opt/python');
		expect(dockerfile).toContain('ln -sfn "$python_bindir/python3" /usr/local/bin/python3');
		expect(dockerfile).not.toContain('python3 \\');
		expect(dockerfile).not.toContain('gh \\');
		expect(dockerfile).not.toContain('pnpm add -g openclaw');
		expect(dockerfile).not.toContain('openclaw doctor');
	});

	it('does not install the native Codex CLI in the OpenClaw gateway base', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'openclaw-gateway', 'Dockerfile'),
			'utf8',
		);

		expect(dockerfile).not.toContain('@openai/codex');
	});

	it('keeps the Tool VM base focused on agent CLI helpers', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'tool-vm', 'Dockerfile'),
			'utf8',
		);

		expect(dockerfile).toContain('npm install -g pnpm@10.33.0');
		expect(dockerfile).toContain('pnpm --version');
		expect(dockerfile).toContain('COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/');
		expect(dockerfile).toContain('uv python install 3.13 --install-dir /opt/python');
		expect(dockerfile).toContain('ripgrep \\');
		expect(dockerfile).toContain('fd-find \\');
		expect(dockerfile).toContain('micro \\');
		expect(dockerfile).not.toContain('python3 \\');
		expect(dockerfile).not.toContain('nano \\');
		expect(dockerfile).not.toContain('vim-tiny');
	});

	it('removes image-build SSH host keys from the Tool VM base', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'tool-vm', 'Dockerfile'),
			'utf8',
		);
		const openSshInstallIndex = dockerfile.indexOf('openssh-server');
		const packageInstallCompletionIndex = dockerfile.indexOf('zip && \\', openSshInstallIndex);
		const hostKeyRemovalIndex = dockerfile.indexOf('rm -f /etc/ssh/ssh_host_*');

		expect(openSshInstallIndex).toBeGreaterThan(-1);
		expect(packageInstallCompletionIndex).toBeGreaterThan(openSshInstallIndex);
		expect(hostKeyRemovalIndex).toBeGreaterThan(packageInstallCompletionIndex);
		expect(dockerfile).not.toContain('ssh-keygen -A');
	});

	it('installs GitHub CLI from GitHub stable apt instead of Debian apt', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'tool-vm', 'Dockerfile'),
			'utf8',
		);
		const githubCliKeyringPath = '/usr/share/keyrings/githubcli-archive-keyring.gpg';
		const githubCliSourcePath = '/etc/apt/sources.list.d/github-cli.list';
		const githubCliSource = 'https://cli.github.com/packages stable main';
		const sourceIndex = dockerfile.indexOf(githubCliSource);
		const installIndex = dockerfile.indexOf('apt-get install -y --no-install-recommends gh');

		expect(dockerfile).toContain('https://cli.github.com/packages/githubcli-archive-keyring.gpg');
		expect(dockerfile).toContain(githubCliKeyringPath);
		expect(dockerfile).toContain('chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg');
		expect(dockerfile).toContain(`signed-by=${githubCliKeyringPath}`);
		expect(dockerfile).toContain(githubCliSource);
		expect(dockerfile).toContain(githubCliSourcePath);
		expect(sourceIndex).toBeGreaterThan(-1);
		expect(installIndex).toBeGreaterThan(sourceIndex);
		expect(dockerfile).toMatch(/apt-get update && \\\n\s+apt-get install -y --no-install-recommends gh/u);
		expect(dockerfile).not.toMatch(/^\s+gh \\/mu);
		expect(dockerfile).not.toContain('apt-key');
		expect(dockerfile).not.toMatch(/token|password|secret|_authToken|_password|_secret/iu);
	});
});
