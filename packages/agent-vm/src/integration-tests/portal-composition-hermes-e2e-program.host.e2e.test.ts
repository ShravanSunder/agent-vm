import { describe, expect, it } from 'vitest';

import {
	buildPortalCompositionProgram,
	validatePortalCompositionGeneratedProgramSyntax,
} from './portal-composition-hermes-e2e-program.js';
import { startPortalCompositionModelServer } from './portal-composition-hermes-e2e-support.js';
import {
	buildPortalCompositionGeneratedTerminalProgram,
	portalCompositionGeneratedTerminalResultMarker,
	validatePortalCompositionGeneratedTerminalProgramSyntax,
} from './portal-composition-hermes-generated-terminal.js';

async function requestDeterministicModel(
	port: number,
	messages: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
		body: JSON.stringify({
			messages,
			tools: [
				{ function: { name: 'execute_code' }, type: 'function' },
				{ function: { name: 'terminal' }, type: 'function' },
			],
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});
	expect(response.status).toBe(200);
	return await response.text();
}

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

describe('portal composition generated foreground terminal program', () => {
	it('uses the exact generated namespace imports from Hermes orientation', async () => {
		const fingerprint = 'a'.repeat(64);
		const program = buildPortalCompositionGeneratedTerminalProgram({
			modelInstructions: [
				'Generated Tool Portal TypeScript imports for this turn:',
				"- import { connectToolPortal } from '@agent-vm/agent-portal-sdk';",
				`- import { bindPortalCompositionExecutionTools } from '/run/agent-vm/tool-portal-sdk/${fingerprint}/portal-composition-execution-11111111.ts';`,
				`- import { bindUpstreamMockTools } from '/run/agent-vm/tool-portal-sdk/${fingerprint}/upstream-mock-22222222.ts';`,
				`- Manifest: /run/agent-vm/tool-portal-sdk/${fingerprint}/manifest.json`,
			].join('\n'),
		});

		expect(program.orientationImports).toEqual({
			configuredCli: {
				exportedFactoryName: 'bindPortalCompositionExecutionTools',
				modulePath: `/run/agent-vm/tool-portal-sdk/${fingerprint}/portal-composition-execution-11111111.ts`,
			},
			mcp: {
				exportedFactoryName: 'bindUpstreamMockTools',
				modulePath: `/run/agent-vm/tool-portal-sdk/${fingerprint}/upstream-mock-22222222.ts`,
			},
		});
		expect(program.source).toContain(portalCompositionGeneratedTerminalResultMarker);
		expect(program.source).toContain('const dependentRead = await upstreamMock.readThing');
		expect(program.source).toContain('await Promise.all([');
		expect(program.source).toContain('portalCompositionExecution.writeToolVmEffect');
		expect(program.command).toContain('node --input-type=module --eval');
		await expect(
			validatePortalCompositionGeneratedTerminalProgramSyntax(program),
		).resolves.toBeUndefined();
	});

	it('drives execute_code followed by foreground terminal from the observed orientation', async () => {
		const fingerprint = 'b'.repeat(64);
		const promptMarker = 'RUN_GENERATED_TERMINAL_HOST_PROOF';
		const programResultMarker = 'generic-program-complete';
		const orientation = [
			'Python connect_tool_portal()',
			'TypeScript connectToolPortal()',
			'/agent-vm/tool-portal.md',
			'for the active foreground invocation; endpoint expires afterward.',
			"- import { connectToolPortal } from '@agent-vm/agent-portal-sdk';",
			`- import { bindPortalCompositionExecutionTools } from '/run/agent-vm/tool-portal-sdk/${fingerprint}/portal-composition-execution-11111111.ts';`,
			`- import { bindUpstreamMockTools } from '/run/agent-vm/tool-portal-sdk/${fingerprint}/upstream-mock-22222222.ts';`,
		].join('\n');
		const server = await startPortalCompositionModelServer({
			compositionProgram: 'print("generic")',
			finalMarker: 'host-proof-finished',
			promptMarker,
			programResultMarker,
		});
		try {
			const messages: Readonly<Record<string, unknown>>[] = [
				{ content: orientation, role: 'system' },
				{ content: promptMarker, role: 'user' },
			];
			const first = await requestDeterministicModel(server.port, messages);
			expect(first).toContain('portal-composition-execute-code');

			messages.push({ content: programResultMarker, role: 'tool' });
			const second = await requestDeterministicModel(server.port, messages);
			expect(second).toContain('portal-composition-generated-terminal');
			expect(second).toContain(portalCompositionGeneratedTerminalResultMarker);

			messages.push({ content: portalCompositionGeneratedTerminalResultMarker, role: 'tool' });
			const third = await requestDeterministicModel(server.port, messages);
			expect(third).toContain('host-proof-finished');
			expect(server.executeCodeRequestCount()).toBe(1);
			expect(server.generatedTerminalRequestCount()).toBe(1);
		} finally {
			await server.close();
		}
	});
});
