import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
function isEmittedModuleNamespace(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('emitted configuration module resolution', () => {
	it('loads the private controller and config helpers from shipped JavaScript', async () => {
		const packageRoot = path.resolve('packages/agent-vm');
		const requireFromBuilt = createRequire(
			pathToFileURL(path.join(packageRoot, 'dist/cli/agent-vm-entrypoint.js')),
		);
		const entries = [
			{
				specifier: '#agent-vm/cli/config-schema-artifacts',
				path: 'dist/cli/config-schema-artifacts.js',
				name: 'createConfigContractSchemaArtifacts',
			},
			{
				specifier: '#agent-vm/controller/oauth/google-account-invocation-policy',
				path: 'dist/controller/oauth/google-account-invocation-policy.js',
				name: 'resolveGoogleAccountInvocationPolicy',
			},
		];
		await Promise.all(
			entries.map(async (entry) => {
				const resolved = requireFromBuilt.resolve(entry.specifier);
				expect(resolved).toBe(path.join(packageRoot, entry.path));
				await access(resolved);
				const namespace: unknown = await import(pathToFileURL(resolved).href);
				if (!isEmittedModuleNamespace(namespace))
					throw new Error('Expected emitted module namespace');
				expect(typeof namespace[entry.name]).toBe('function');
			}),
		);
	});
});
