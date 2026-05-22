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

	it('pins pnpm in the OpenClaw gateway base to preserve the global package layout', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'openclaw-gateway', 'Dockerfile'),
			'utf8',
		);

		expect(dockerfile).toContain('corepack prepare pnpm@10.33.0 --activate');
		expect(dockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(dockerfile).toContain('exec /pnpm/openclaw "$@"');
	});

	it('installs the native Codex CLI in the OpenClaw gateway base for harness auth', async () => {
		const dockerfile = await fs.readFile(
			path.join(process.cwd(), 'docker', 'base-images', 'openclaw-gateway', 'Dockerfile'),
			'utf8',
		);

		expect(dockerfile).toContain('pnpm add -g openclaw@2026.5.2 @openai/codex');
	});
});
