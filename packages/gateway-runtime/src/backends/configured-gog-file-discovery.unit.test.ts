import { gogCommandDescriptorSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { configuredGogFileDiscovery } from './configured-gog-file-discovery.js';

describe('configured Gog file discovery', () => {
	it('describes the input root, output convention, limits and exact descriptor file arguments', () => {
		// Arrange
		const descriptor = gogCommandDescriptorSchema.parse({
			operationId: 'drive.upload',
			familyId: 'documents',
			paths: [['drive', 'upload']],
			requirements: [{ serviceId: 'drive', effects: ['write'] }],
			sendsMail: false,
			positionals: { minimum: 1, maximum: 1, fileInputs: [0] },
			flags: [],
		});
		// Act
		const result = configuredGogFileDiscovery([descriptor]);
		// Assert
		expect(result).toMatchObject({
			inputRoot: '/work',
			maximumFileBytes: 16777216,
			maximumRetainedBytes: 67108864,
			operationReferenceTtlMs: 3600000,
			commands: [
				{
					operationId: 'drive.upload',
					paths: [['drive', 'upload']],
					inputPositions: [0],
					fileFlags: [],
				},
			],
		});
		expect(result?.instructions).toContain('not the terminal');
		expect(result?.instructions).toContain('actual returned');
		expect(result?.instructions).toContain('/agent-vm/files');
		expect(result?.instructions).toContain(
			'Structured Sandbox filesystem requests remain /work-relative',
		);
		expect(result?.instructions).toContain('when this Tool VM closes');
		expect(result?.instructions).toContain('reads do not extend');
	});
	it('does not advertise file support for a non-file operation', () => {
		// Arrange / Act / Assert
		expect(configuredGogFileDiscovery([])).toBeUndefined();
	});
});
