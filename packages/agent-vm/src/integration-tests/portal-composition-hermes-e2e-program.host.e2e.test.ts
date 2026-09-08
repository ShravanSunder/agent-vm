import { describe, expect, it } from 'vitest';

import {
	buildPortalCompositionProgram,
	validatePortalCompositionGeneratedProgramSyntax,
} from './portal-composition-hermes-e2e-program.js';

describe('portal composition generated program syntax', () => {
	it('parses the exact Python composition and embedded Node program without executing them', async () => {
		const program = buildPortalCompositionProgram({
			hostSentinelPath: '/tmp/portal-composition-host-only-sentinel',
		});

		await expect(validatePortalCompositionGeneratedProgramSyntax(program)).resolves.toBeUndefined();
	});

	it.each(['Python', 'Node'])(
		'rejects invalid %s without executing either program',
		async (language) => {
			const program = buildPortalCompositionProgram({
				hostSentinelPath: '/tmp/portal-syntax-sentinel',
			});
			const invalidProgram =
				language === 'Python'
					? { ...program, pythonProgram: 'return 1' }
					: { ...program, nodeProgram: 'const =' };
			await expect(validatePortalCompositionGeneratedProgramSyntax(invalidProgram)).rejects.toThrow(
				`${language} composition syntax check failed`,
			);
		},
	);
});
