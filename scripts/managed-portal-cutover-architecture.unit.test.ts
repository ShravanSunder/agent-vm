import { describe, expect, it } from 'vitest';

import { collectManagedPortalCutoverViolations } from './audit-portal-architecture.js';
describe('managed private cutover dependency boundary', () => {
	it.each([
		"import {createManagedToolPortalCapabilityCore} from '@agent-vm/tool-portal';",
		"const factory=await import('@agent-vm/mcp-portal/mcp-provider-backend');",
		"export * from '../../../tool-portal/src/index.js';",
	])("refuses production's old implementation: %s", (sourceText) => {
		expect(
			collectManagedPortalCutoverViolations({
				filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
				sourceText,
			}),
		).toHaveLength(1);
	});
	it('admits production shared engine and runtime-owned facade imports', () => {
		expect(
			collectManagedPortalCutoverViolations({
				filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
				sourceText:
					"import {createManagedToolPortalCapabilityCore} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-portal-facade.js'; import {createCapabilityDispatcher} from '@agent-collaboration/tool-engine/capability-dispatch';",
			}),
		).toEqual([]);
	});
	it('keeps the historical oracle available to comparison tests', () => {
		expect(
			collectManagedPortalCutoverViolations({
				filePath: 'packages/gateway-runtime/src/tool-portal-projections.integration.test.ts',
				sourceText: "import {createManagedToolPortalCapabilityCore} from '@agent-vm/tool-portal';",
			}),
		).toEqual([]);
	});
});
