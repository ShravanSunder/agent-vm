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

	it('produces the same namespace for the same canonical path across calls', async () => {
		const firstNamespace = await buildDefaultProjectNamespace('/tmp/project-link', {
			realpath: async () => '/tmp/Canonical Project',
		});
		const secondNamespace = await buildDefaultProjectNamespace('/tmp/project-link', {
			realpath: async () => '/tmp/Canonical Project',
		});

		expect(firstNamespace).toBe(secondNamespace);
	});

	it('falls back to the generic slug when the basename is entirely non-ascii', async () => {
		await expect(
			buildDefaultProjectNamespace('/tmp/リンク', {
				realpath: async () => '/tmp/プロジェクト',
			}),
		).resolves.toMatch(/^agent-vm-[0-9a-f]{8}$/u);
	});
});
