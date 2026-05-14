import { describe, expect, it } from 'vitest';

import { createBeforePromptBuildHandler } from './before-prompt-build-handler.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

function createRuntimeState(): ReturnType<typeof createPortalPluginRuntimeState> {
	return createPortalPluginRuntimeState({
		configDir: '/config',
		loadPortalConfig: async () => ({
			agents: {
				hidden: { profile: 'quiet' },
				shravan: { profile: 'builder' },
			},
			profiles: {
				builder: {
					enabledNamespaces: ['linear', 'github', 'readwise'],
					promptContext: { enabled: true, maxNamespaces: 2 },
				},
				quiet: {
					enabledNamespaces: ['linear'],
					promptContext: { enabled: false, maxNamespaces: 12 },
				},
			},
			schemaVersion: 1,
			server: {
				accessHeader: {
					name: 'x-secret',
					secret: { name: 'MCP_PORTAL_SECRET', source: 'environment' },
				},
				host: '127.0.0.1',
				port: 18_790,
			},
		}),
	});
}

describe('createBeforePromptBuildHandler', () => {
	it('returns undefined without an agent id', async () => {
		const handler = createBeforePromptBuildHandler({ runtimeState: createRuntimeState() });

		await expect(handler({}, {})).resolves.toBeUndefined();
	});

	it('returns undefined when prompt context is disabled', async () => {
		const handler = createBeforePromptBuildHandler({ runtimeState: createRuntimeState() });

		await expect(handler({}, { agentId: 'hidden' })).resolves.toBeUndefined();
	});

	it('lists enabled namespaces capped by profile prompt settings', async () => {
		const handler = createBeforePromptBuildHandler({ runtimeState: createRuntimeState() });

		const result = await handler({}, { agentId: 'shravan' });

		expect(result?.appendSystemContext).toContain('github');
		expect(result?.appendSystemContext).toContain('linear');
		expect(result?.appendSystemContext).not.toContain('readwise');
	});
});
