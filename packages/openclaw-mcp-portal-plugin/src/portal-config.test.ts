import { describe, expect, it } from 'vitest';

import { parsePortalConfig } from './portal-config.js';

describe('portal config', () => {
	it('applies safe defaults', () => {
		expect(parsePortalConfig({})).toMatchObject({
			approval: {
				allowWithoutApprovalTools: [],
				alwaysAskTools: [],
				annotationPolicy: 'destructive-requires-approval',
				trustedAnnotationNamespaces: [],
				writeTools: [],
			},
			cache: { catalogTtlMs: 60000 },
			enabledNamespaces: [],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
			promptContext: { enabled: true, maxNamespaces: 12 },
			skillsDirs: [],
		});
	});

	it('rejects upstream mcpServers in plugin config', () => {
		expect(() => parsePortalConfig({ mcpServers: { linear: {} } })).toThrow();
	});

	it('allows agent-specific exposure config', () => {
		expect(
			parsePortalConfig({
				enabledNamespacesByAgent: { 'agent-a': ['linear'], 'agent-b': ['readwise'] },
			}),
		).toMatchObject({
			enabledNamespacesByAgent: { 'agent-a': ['linear'], 'agent-b': ['readwise'] },
		});
	});
});
