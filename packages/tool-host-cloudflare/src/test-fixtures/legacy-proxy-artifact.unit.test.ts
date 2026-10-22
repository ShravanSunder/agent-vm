import { expect, it } from 'vitest';

import { assertPinnedLegacyArtifacts } from '#worker-host/test-fixtures/legacy-proxy-artifact';

const input = {
	aliasSpecifier: 'npm:@agent-vm/mcp-portal@0.0.153',
	legacyManifest: {
		name: '@agent-vm/mcp-portal',
		version: '0.0.153',
		dependencies: { '@agent-vm/config-contracts': '0.0.153' },
	},
	configManifest: { name: '@agent-vm/config-contracts', version: '0.0.153' },
	legacyDirectory: '/installed/legacy',
	configDirectory: '/installed/config',
	workspaceDirectory: '/checkout/',
	lockfile:
		"  '@agent-vm/mcp-portal@0.0.153':\n    resolution: {integrity: sha512-IMzAWXVPTh++vruqIRKws7e7D4mbFn6T94RYLXV3p3Wjy6ITaDBe9tlpCbeOdlplLc63TGJmDIyL9wURkEMhjw==}\n  '@agent-vm/config-contracts@0.0.153':\n    resolution: {integrity: sha512-pQuYQnp90VETQ6EO0w5iBS0pdYD9kCShJZQ9/enyp2ZXhspdocShrVRjAQaBx+8n+hbz9XgxaLgWWiim/9Ge0w==}\n",
};

it('admits the literal released artifact identities and lock integrities', () => {
	expect(() => assertPinnedLegacyArtifacts(input)).not.toThrow();
});
it.each([
	{ aliasSpecifier: 'workspace:*' },
	{ legacyManifest: { ...input.legacyManifest, version: '0.0.154' } },
	{ configManifest: { ...input.configManifest, version: '0.0.154' } },
	{
		legacyManifest: {
			...input.legacyManifest,
			dependencies: { '@agent-vm/config-contracts': '^0.0.153' },
		},
	},
	{ legacyDirectory: '/checkout/packages/mcp-portal' },
	{ configDirectory: '/checkout/packages/config-contracts' },
	{
		lockfile: input.lockfile.replace(
			'sha512-IMzAWXVPTh++vruqIRKws7e7D4mbFn6T94RYLXV3p3Wjy6ITaDBe9tlpCbeOdlplLc63TGJmDIyL9wURkEMhjw==',
			'sha512-wrong',
		),
	},
	{
		lockfile: input.lockfile.replace(
			'sha512-pQuYQnp90VETQ6EO0w5iBS0pdYD9kCShJZQ9/enyp2ZXhspdocShrVRjAQaBx+8n+hbz9XgxaLgWWiim/9Ge0w==',
			'sha512-wrong',
		),
	},
])('rejects a different or workspace-backed oracle: %j', (change) => {
	expect(() => assertPinnedLegacyArtifacts({ ...input, ...change })).toThrow();
});
