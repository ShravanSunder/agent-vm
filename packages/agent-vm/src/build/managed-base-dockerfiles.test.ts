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

			expect(dockerfile).toContain('ln -sf /proc/self/fd /dev/fd');
		},
	);
});
