import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { StartedFakeUpstreamMcpServer } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { portalCompositionApprovalTitle } from './portal-composition-approval-test-fixture.js';
import type { startPortalCompositionModelServer } from './portal-composition-hermes-e2e-support.js';
import { portalCompositionProgramPhaseFilename } from './portal-composition-hermes-e2e-test-fixture.js';

export async function assertPortalCompositionResults(props: {
	readonly response: string;
	readonly finalMarker: string;
	readonly modelServer: Awaited<ReturnType<typeof startPortalCompositionModelServer>>;
	readonly mcpServer: StartedFakeUpstreamMcpServer;
	readonly programResultMarker: string;
	readonly resultDerivedValue: string;
	readonly hostEffectPath: string;
	readonly hiddenHostEffectPath: string;
	readonly concurrencyOrderPath: string;
	readonly lossOrderPath: string;
	readonly hostSentinelPath: string;
	readonly controllerManagedVmRequests: readonly ManagedVmCreateRequest[];
}): Promise<void> {
	const {
		response,
		finalMarker,
		modelServer,
		mcpServer,
		programResultMarker,
		resultDerivedValue,
		hostEffectPath,
		hiddenHostEffectPath,
		concurrencyOrderPath,
		lossOrderPath,
		hostSentinelPath,
		controllerManagedVmRequests,
	} = props;
	expect(
		response,
		`Raw foreground results: ${JSON.stringify({ executeCode: modelServer.latestExecuteCodeResult(), generatedTerminal: modelServer.latestGeneratedTerminalResult() })}`,
	).toContain(finalMarker);
	expect(modelServer.executeCodeRequestCount()).toBe(2);
	expect(modelServer.generatedTerminalRequestCount()).toBe(1);
	const resetProbeResult = modelServer.secondExecuteCodeResult();
	const resetProbeEnvelope = z
		.object({
			kernel: z.object({
				remote: z.literal(true),
				reused: z.literal(false),
				state_reset: z.literal(true),
			}),
			output: z.string(),
			status: z.literal('success'),
		})
		.parse(JSON.parse(resetProbeResult ?? 'null'));
	expect(resetProbeEnvelope.output).toContain('portal-composition-kernel-reset-probe');
	const executeCodeResult = modelServer.latestExecuteCodeResult();
	expect(executeCodeResult).toContain(programResultMarker);
	expect(executeCodeResult).toContain(resultDerivedValue);
	expect(executeCodeResult).toContain('hostSentinelVisible');
	expect(executeCodeResult).toContain('/opt/agent-vm-tools/bin/python');
	const executionEnvelope = z
		.object({
			kernel: z.object({ remote: z.literal(true), reused: z.literal(false) }),
			output: z.string(),
			status: z.literal('success'),
		})
		.parse(JSON.parse(executeCodeResult ?? 'null'));
	const compositionOutput: unknown = JSON.parse(executionEnvelope.output);
	expect(compositionOutput).toMatchObject({
		capacityReuse: { artifactBytes: 70 * 256 * 3_840, independentOperationCount: 3 },
		toolVmConfiguredCli: {
			effect: resultDerivedValue,
			result: {
				ok: true,
				items: [
					{
						id: 'python-tool-vm-write',
						status: 'ok',
						outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
						value: {
							exitCode: 0,
							stderrTruncated: false,
							stdout: `tool-vm:${resultDerivedValue}`,
							stdoutTruncated: false,
						},
					},
				],
			},
		},
	});
	const generatedTerminalProgram = modelServer.observedGeneratedTerminalProgram();
	expect(generatedTerminalProgram?.orientationImports).toEqual({
		configuredCli: {
			exportedFactoryName: 'bindPortalCompositionExecutionTools',
			modulePath: expect.stringMatching(
				/^\/run\/agent-vm\/tool-portal-sdk\/[a-f0-9]{64}\/portal-composition-execution-[a-f0-9]{8}\.ts$/u,
			),
		},
		mcp: {
			exportedFactoryName: 'bindUpstreamMockTools',
			modulePath: expect.stringMatching(
				/^\/run\/agent-vm\/tool-portal-sdk\/[a-f0-9]{64}\/upstream-mock-[a-f0-9]{8}\.ts$/u,
			),
		},
	});
	const generatedTerminalResult = modelServer.latestGeneratedTerminalResult();
	expect(generatedTerminalResult).toContain('portal-composition-generated-terminal-complete');
	const generatedTerminalEnvelope = z
		.object({ exit_code: z.literal(0), output: z.string(), error: z.null() })
		.parse(JSON.parse(generatedTerminalResult ?? 'null'));
	const generatedTerminalOutput = z
		.object({
			concurrentConfiguredCli: PortalCallResultSchema,
			concurrentMcpWrite: PortalCallResultSchema,
			dependentRead: PortalCallResultSchema,
			derivedValue: z.literal('generated-from-read-thing'),
			manifestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
			marker: z.literal('portal-composition-generated-terminal-complete'),
			orientationImports: z.object({
				configuredCli: z.object({
					exportedFactoryName: z.literal('bindPortalCompositionExecutionTools'),
					modulePath: z.string(),
				}),
				mcp: z.object({
					exportedFactoryName: z.literal('bindUpstreamMockTools'),
					modulePath: z.string(),
				}),
			}),
		})
		.parse(JSON.parse(generatedTerminalEnvelope.output));
	expect(generatedTerminalOutput.orientationImports).toEqual(
		generatedTerminalProgram?.orientationImports,
	);
	expect(generatedTerminalOutput.orientationImports.mcp.modulePath.split('/').at(-2)).toBe(
		generatedTerminalOutput.manifestFingerprint,
	);
	expect(generatedTerminalOutput.dependentRead.items[0]).toMatchObject({
		outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
		status: 'ok',
		value: { result: { structuredContent: { name: 'read_thing', ok: true } } },
	});
	expect(generatedTerminalOutput.concurrentMcpWrite.items[0]).toMatchObject({
		outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
		status: 'ok',
		value: { result: { structuredContent: { name: 'write_thing', ok: true } } },
	});
	expect(generatedTerminalOutput.concurrentConfiguredCli.items[0]).toMatchObject({
		outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
		status: 'ok',
		value: {
			exitCode: 0,
			stdout: 'tool-vm:generated-from-read-thing',
		},
	});
	expect(
		mcpServer.calls.filter(
			(call) =>
				!(
					call.name === 'write_thing' &&
					z
						.object({ title: z.literal(portalCompositionApprovalTitle) })
						.safeParse(call.argumentsValue).success
				),
		),
	).toEqual([
		{ argumentsValue: { title: 'python-seed' }, name: 'read_thing' },
		{ argumentsValue: { title: resultDerivedValue }, name: 'write_thing' },
		{ argumentsValue: { title: 'generated-terminal-seed' }, name: 'read_thing' },
		{ argumentsValue: { title: 'generated-from-read-thing' }, name: 'write_thing' },
	]);
	expect(JSON.parse(await readFile(hostEffectPath, 'utf8'))).toEqual({
		argv: ['write-host-effect', resultDerivedValue],
		destination: 'controller-host',
	});
	await expect(access(`${hostEffectPath}.forged`)).rejects.toThrow();
	await expect(access(hiddenHostEffectPath)).rejects.toThrow();
	expect(await readFile(concurrencyOrderPath, 'utf8')).toBe(
		['prepared', 'slow-admitted', 'fast-completed', 'release-started', 'slow-completed', ''].join(
			'\n',
		),
	);
	expect(await readFile(lossOrderPath, 'utf8')).toBe(
		['loss-prepared', 'loss-admitted', 'loss-fast', ''].join('\n'),
	);
	await expect(access(hostSentinelPath)).resolves.toBeUndefined();
	const toolVmRequest = controllerManagedVmRequests.find(
		(request) => request.mounts['/workspace']?.kind === 'owned-filtered-workspace',
	);
	const workspaceMount = toolVmRequest?.mounts['/workspace'];
	if (workspaceMount?.kind !== 'owned-filtered-workspace') {
		throw new Error('Portal composition E2E did not observe the Tool VM workspace mount.');
	}
	const programPhase: unknown = JSON.parse(
		await readFile(
			path.join(
				workspaceMount.directory.identity.canonicalPath,
				portalCompositionProgramPhaseFilename,
			),
			'utf8',
		),
	);
	expect(programPhase).toEqual({ phase: 'loss-prepare-returned' });
	const toolVmOrigin: unknown = JSON.parse(
		await readFile(
			path.join(
				workspaceMount.directory.identity.canonicalPath,
				'portal-composition-tool-vm-origin.json',
			),
			'utf8',
		),
	);
	expect(toolVmOrigin).toMatchObject({ hostSentinelVisible: false });
	expect(toolVmOrigin).toEqual({
		cwd: expect.stringMatching(/^\/tmp\/hermes_rkernel_[0-9a-f]{12}$/u),
		hostSentinelVisible: false,
		interpreter: expect.stringMatching(/^\/opt\/agent-vm-tools\/bin\/python(?:3(?:\.\d+)?)?$/u),
	});
	expect(
		controllerManagedVmRequests.some((request) =>
			request.sessionLabel.startsWith('credentialed-runtime-'),
		),
	).toBe(true);
	expect(
		controllerManagedVmRequests.some(
			(request) => !request.sessionLabel.startsWith('credentialed-runtime-'),
		),
	).toBe(true);
}
