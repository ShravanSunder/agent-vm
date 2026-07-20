import { toolPortalConfigSchema, type ToolPortalConfig } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { compileGatewayRuntimeToolVmRunnerConfiguredCatalog } from './tool-vm-runner-configured-catalog.js';

function parsedToolPortalConfig(): ToolPortalConfig {
	return toolPortalConfigSchema.parse({
		agents: {
			'agent-builder': { profile: 'code-builder' },
			'agent-reviewer': { profile: 'reviewer' },
		},
		mode: 'managed',
		profiles: {
			'code-builder': {
				namespaces: {
					sandbox: {
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								process_cancel: {
									description: 'Cancel one bounded build process.',
									kind: 'process.cancel',
								},
								process_logs: {
									description: 'Read bounded build-process logs.',
									kind: 'process.logs',
								},
								process_start: {
									description: 'Start the fixed build watcher.',
									executable: '/usr/bin/watch-build',
									kind: 'process.start',
									mandatoryArgvPrefix: ['--fixed'],
									maxRuntimeMs: 30_000,
									retainOutputBytes: 4_096,
									workingDirectory: 'repo',
								},
								process_status: {
									description: 'Read bounded build-process status.',
									kind: 'process.status',
								},
								process_wait: {
									description: 'Wait briefly for bounded build-process completion.',
									kind: 'process.wait',
									timeoutMs: 500,
								},
								read_file: {
									description: 'Read one bounded source file.',
									kind: 'filesystem.read',
								},
								run_checks: {
									description: 'Run the configured unit checks.',
									executable: '/usr/bin/pnpm',
									kind: 'command.fixed',
									mandatoryArgvPrefix: ['test:unit'],
									workingDirectory: 'repo',
								},
								write_file: {
									description: 'Write one bounded source file.',
									kind: 'filesystem.write',
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: '*', deny: [] },
						},
						tools: { allow: '*', deny: [] },
					},
				},
			},
			reviewer: {
				namespaces: {
					sandbox: {
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								run_checks: {
									description: 'Run the reviewer check command.',
									executable: '/usr/bin/true',
									kind: 'command.fixed',
									mandatoryArgvPrefix: [],
									workingDirectory: '.',
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['run_checks'], deny: [] },
						},
						tools: { allow: ['run_checks'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

describe('configured Tool VM runner catalog compiler', () => {
	it('derives profile-indexed runtime bindings while allowing one public ref to differ by profile', () => {
		const catalog = compileGatewayRuntimeToolVmRunnerConfiguredCatalog(parsedToolPortalConfig());

		expect(catalog['code-builder']?.map((entry) => entry.summary.toolRef)).toEqual([
			'sandbox.process_cancel',
			'sandbox.process_logs',
			'sandbox.process_start',
			'sandbox.process_status',
			'sandbox.process_wait',
			'sandbox.read_file',
			'sandbox.run_checks',
			'sandbox.write_file',
		]);
		expect(
			catalog['code-builder']?.find((entry) => entry.summary.name === 'run_checks'),
		).toMatchObject({
			operation: { argv: ['/usr/bin/pnpm', 'test:unit'], cwd: 'repo', kind: 'exec' },
			summary: {
				description: 'Run the configured unit checks.',
				safety: { destructiveHint: true, readOnlyHint: false },
			},
		});
		expect(catalog.reviewer?.find((entry) => entry.summary.name === 'run_checks')).toMatchObject({
			operation: { argv: ['/usr/bin/true'], cwd: '.', kind: 'exec' },
		});
	});

	it('derives fixed public schemas, summaries, and safety for every configured operation kind', () => {
		const catalog = compileGatewayRuntimeToolVmRunnerConfiguredCatalog(parsedToolPortalConfig());
		const entriesByName = Object.fromEntries(
			(catalog['code-builder'] ?? []).map((entry) => [entry.summary.name, entry]),
		);

		expect(entriesByName.run_checks).toMatchObject({
			descriptor: {
				inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
				name: 'run_checks',
				namespace: 'sandbox',
				toolRef: 'sandbox.run_checks',
			},
		});
		expect(entriesByName.read_file).toMatchObject({
			operation: { kind: 'read-file' },
			summary: { safety: { readOnlyHint: true } },
		});
		expect(entriesByName.write_file).toMatchObject({
			descriptor: {
				inputSchema: {
					additionalProperties: false,
					properties: {
						content: { maxLength: 65_536, type: 'string' },
						path: { maxLength: 4_096, minLength: 1, type: 'string' },
					},
					required: ['content', 'path'],
					type: 'object',
				},
			},
			operation: { kind: 'write-file' },
			summary: { safety: { destructiveHint: true, readOnlyHint: false } },
		});
		expect(entriesByName.process_logs).toMatchObject({
			operation: { kind: 'process-logs' },
			summary: { safety: { readOnlyHint: true } },
		});
		expect(entriesByName.process_start).toMatchObject({
			descriptor: { inputSchema: { additionalProperties: false, properties: {} } },
			operation: {
				argv: ['/usr/bin/watch-build', '--fixed'],
				cwd: 'repo',
				kind: 'process-start',
				maxRuntimeMs: 30_000,
				retainOutputBytes: 4_096,
			},
		});
		expect(entriesByName.process_wait).toMatchObject({
			operation: { kind: 'process-wait', timeoutMs: 500 },
		});
	});

	it('never accepts authored descriptors, schemas, tool refs, runner selectors, or request authority', () => {
		const catalog = compileGatewayRuntimeToolVmRunnerConfiguredCatalog(parsedToolPortalConfig());
		const serializedCatalog = JSON.stringify(catalog);

		expect(serializedCatalog).not.toMatch(
			/backendKind|credential|environmentScope|host|identityPem|knownHostsLine|privateKey|profileAssignmentRevision|runnerProfile|sshBindingId/u,
		);
		expect(serializedCatalog).toContain('sandbox.run_checks');
	});
});
