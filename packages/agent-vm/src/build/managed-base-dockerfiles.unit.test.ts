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
		expect(dockerfile).toContain('gh \\');
		expect(dockerfile).toContain('ripgrep \\');
		expect(dockerfile).toContain('fd-find \\');
		expect(dockerfile).toContain('micro \\');
		expect(dockerfile).not.toContain('python3 \\');
		expect(dockerfile).not.toContain('nano \\');
		expect(dockerfile).not.toContain('vim-tiny');
	});
});
