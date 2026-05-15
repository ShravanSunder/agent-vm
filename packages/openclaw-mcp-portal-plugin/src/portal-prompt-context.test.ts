import { describe, expect, it } from 'vitest';

import { createPortalPromptContext } from './portal-prompt-context.js';

describe('portal prompt context', () => {
	it('lists only allowed namespaces without schemas or secrets', () => {
		const context = createPortalPromptContext({
			diagnostics: [{ message: 'github unavailable', namespace: 'github' }],
			namespaces: [
				{ namespace: 'linear', toolCount: 18 },
				{ namespace: 'readwise', toolCount: 9 },
			],
		});

		expect(context).toContain('mcp_portal_describe');
		expect(context).toContain('Namespaces: linear(18 tools), readwise(9 tools)');
		expect(context).toContain('Discovery diagnostics: github: github unavailable');
		expect(context).not.toContain('inputSchema');
		expect(context).not.toContain('secret');
	});
});
