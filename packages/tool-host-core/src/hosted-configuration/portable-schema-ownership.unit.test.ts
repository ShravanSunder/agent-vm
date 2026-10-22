import * as portableContracts from '@agent-collaboration/tool-access/contracts';
import { expect, it } from 'vitest';

import * as hostedContracts from '#tool-host-core/index';

it('reuses the portable provider and secret schemas as the single parsing authority', () => {
	expect(hostedContracts.mcpConfigSchema).toBe(portableContracts.mcpConfigSchema);
	expect(hostedContracts.mcpProviderSchema).toBe(portableContracts.mcpProviderSchema);
	expect(hostedContracts.mcpSecretPolicySchema).toBe(portableContracts.mcpSecretPolicySchema);
	expect(hostedContracts.namespaceDiscoverySchema).toBe(portableContracts.namespaceDiscoverySchema);
	expect(hostedContracts.secretValueSchema).toBe(portableContracts.secretValueSchema);
	expect(hostedContracts.formattedSecretValueSchema).toBe(portableContracts.formattedSecretValueSchema);
	expect(hostedContracts.secretFormatSchema).toBe(portableContracts.secretFormatSchema);
});
