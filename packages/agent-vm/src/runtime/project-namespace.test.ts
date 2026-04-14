import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDefaultProjectNamespace } from './project-namespace.js';

describe('buildDefaultProjectNamespace', () => {
	it('uses the real path basename and a stable short hash', async () => {
		await expect(
			buildDefaultProjectNamespace('/tmp/link-to-project', {
				realpath: async () => '/tmp/My Project',
			}),
		).resolves.toMatch(/^my-project-[0-9a-f]{8}$/u);
	});

	it('falls back to path.resolve when realpath fails', async () => {
		const tempDirectory = path.join(os.tmpdir(), 'Agent VM Project');

		await expect(
			buildDefaultProjectNamespace(tempDirectory, {
				realpath: async () => {
					throw new Error('missing path');
				},
			}),
		).resolves.toMatch(/^agent-vm-project-[0-9a-f]{8}$/u);
	});
});
