import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();

vi.mock('execa', () => ({
	execa: execaMock,
}));

function buildRepoResourceSetup(options: {
	readonly outputDir?: string;
	readonly repoDir: string;
	readonly repoId?: string;
	readonly repoUrl?: string;
}): {
	readonly outputDir: string;
	readonly repoDir: string;
	readonly repoId: string;
	readonly repoUrl: string;
	readonly setupCommand: string;
} {
	const repoId = options.repoId ?? 'repo-a';
	return {
		repoId,
		repoUrl: options.repoUrl ?? `https://github.com/example/${repoId}.git`,
		repoDir: options.repoDir,
		outputDir: options.outputDir ?? path.join(options.repoDir, 'output'),
		setupCommand: '.agent-vm/run-setup.sh',
	};
}

describe('repo resource provider runner', () => {
	beforeEach(() => {
		execaMock.mockReset();
		delete process.env.AGENT_VM_SECRET_LEAK_TEST;
	});

	it('starts selected compose providers with task and repo scoped compose project names', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\treturn { requires: {}, provides: {} };
}

export async function finalizeRepoResourceSetup(
\tinput: FinalizeRepoResourceSetupInput,
): Promise<RepoResourcesFinal> {
\treturn {
\t\tresources: Object.fromEntries(
\t\t\tObject.entries(input.selectedResources).map(([name, resource]) => [
\t\t\t\tname,
\t\t\t\t{ binding: resource.binding, target: resource.target, env: {} },
\t\t\t]),
\t\t),
\t\tgenerated: [],
\t};
}
`,
			'utf8',
		);
		execaMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ services: { pg: {} } }),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: { '5432/tcp': {} },
							Labels: { 'com.docker.compose.service': 'pg' },
						},
						NetworkSettings: {
							Networks: { default: { IPAddress: '172.30.0.8' } },
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					resources: {
						pg: {
							binding: { host: 'pg.local', port: 5432 },
							target: { host: '172.30.0.8', port: 5432 },
							env: {},
						},
					},
					generated: [],
				}),
				stderr: '',
				exitCode: 0,
			});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		const result = await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [buildRepoResourceSetup({ repoDir })],
			providers: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					repoDir,
					outputDir: path.join(repoDir, 'output'),
					resourceName: 'pg',
					setupCommand: '.agent-vm/run-setup.sh',
					binding: { host: 'pg.local', port: 5432 },
					provider: {
						type: 'compose',
						service: 'pg',
					},
				},
			],
		});

		expect(execaMock).toHaveBeenCalledWith(
			'docker',
			[
				'compose',
				'-p',
				'agent-vm-task-123-repo-a',
				'-f',
				path.join(repoDir, '.agent-vm', 'docker-compose.yml'),
				'up',
				'-d',
				'--wait',
				'--no-deps',
				'pg',
			],
			expect.objectContaining({
				cwd: repoDir,
				extendEnv: false,
				timeout: expect.any(Number),
			}),
		);
		expect(execaMock).toHaveBeenCalledWith(
			path.join(repoDir, '.agent-vm', 'run-setup.sh'),
			[],
			expect.objectContaining({
				cwd: repoDir,
				extendEnv: false,
				timeout: expect.any(Number),
				env: expect.objectContaining({
					COMPOSE_PROJECT_NAME: 'agent-vm-task-123-repo-a',
					RESOURCE_OUTPUT_DIR: path.join(repoDir, 'output'),
				}),
			}),
		);
		expect(result.finalizations[0]?.final.resources.pg?.target).toEqual({
			host: '172.30.0.8',
			port: 5432,
		});
	});

	it('starts one compose project when one repo provides multiple logical resources', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-multi-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\treturn { requires: {}, provides: {} };
}

export function finalizeRepoResourceSetup(
\tinput: FinalizeRepoResourceSetupInput,
): RepoResourcesFinal {
\treturn {
\t\tresources: Object.fromEntries(
\t\t\tObject.entries(input.selectedResources).map(([name, resource]) => [
\t\t\t\tname,
\t\t\t\t{ binding: resource.binding, target: resource.target, env: {} },
\t\t\t]),
\t\t),
\t\tgenerated: [],
\t};
}
`,
			'utf8',
		);
		const inspectedPgContainer = JSON.stringify([
			{
				Config: {
					ExposedPorts: { '5432/tcp': {} },
					Labels: { 'com.docker.compose.service': 'pg' },
				},
				NetworkSettings: {
					Networks: { default: { IPAddress: '172.30.0.8' } },
				},
			},
		]);
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'docker' && args[5] === 'config') {
				return { stdout: JSON.stringify({ services: { pg: {} } }), stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'up') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'ps') {
				return { stdout: 'container-1\n', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[0] === 'inspect') {
				return { stdout: inspectedPgContainer, stderr: '', exitCode: 0 };
			}
			if (command.endsWith('/.agent-vm/run-setup.sh')) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'node') {
				return {
					stdout: JSON.stringify({
						resources: {
							pg: {
								binding: { host: 'pg.local', port: 5432 },
								target: { host: '172.30.0.8', port: 5432 },
								env: {},
							},
							'pg-blah': {
								binding: { host: 'pg-blah.local', port: 5432 },
								target: { host: '172.30.0.8', port: 5432 },
								env: {},
							},
						},
						generated: [],
					}),
					stderr: '',
					exitCode: 0,
				};
			}
			throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		const result = await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [buildRepoResourceSetup({ repoDir })],
			providers: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					repoDir,
					outputDir: path.join(repoDir, 'output'),
					resourceName: 'pg',
					setupCommand: '.agent-vm/run-setup.sh',
					binding: { host: 'pg.local', port: 5432 },
					provider: {
						type: 'compose',
						service: 'pg',
					},
				},
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					repoDir,
					outputDir: path.join(repoDir, 'output'),
					resourceName: 'pg-blah',
					setupCommand: '.agent-vm/run-setup.sh',
					binding: { host: 'pg-blah.local', port: 5432 },
					provider: {
						type: 'compose',
						service: 'pg',
					},
				},
			],
		});

		const composeUpCalls = execaMock.mock.calls.filter(
			([command, args]) => command === 'docker' && Array.isArray(args) && args[5] === 'up',
		);
		expect(composeUpCalls).toHaveLength(1);
		expect(composeUpCalls[0]?.[1]).toEqual([
			'compose',
			'-p',
			'agent-vm-task-123-repo-a',
			'-f',
			path.join(repoDir, '.agent-vm', 'docker-compose.yml'),
			'up',
			'-d',
			'--wait',
			'--no-deps',
			'pg',
		]);
		const setupCalls = execaMock.mock.calls.filter(([command]) =>
			command.endsWith('/.agent-vm/run-setup.sh'),
		);
		expect(setupCalls).toHaveLength(1);
		expect(setupCalls[0]?.[1]).toEqual([]);
		expect(setupCalls[0]?.[2]).toEqual(
			expect.objectContaining({
				cwd: repoDir,
				env: expect.objectContaining({
					COMPOSE_PROJECT_NAME: 'agent-vm-task-123-repo-a',
					RESOURCE_OUTPUT_DIR: path.join(repoDir, 'output'),
				}),
			}),
		);
		expect(result.startedProviders).toHaveLength(1);
		expect(result.finalizations).toHaveLength(1);
		expect(Object.keys(result.finalizations[0]?.final.resources ?? {})).toEqual(['pg', 'pg-blah']);
	});

	it('rejects provider inputs that do not match the repo setup group', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-mismatch-'));
		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');

		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir: path.join(repoDir, 'other-copy'),
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: { type: 'compose', service: 'pg' },
					},
				],
			}),
		).rejects.toThrow(/inconsistent paths/u);
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: { type: 'compose', service: 'pg' },
					},
				],
			}),
		).rejects.toThrow(/unknown setup repo 'repo-a'/u);
	});

	it('runs repo setup once for every repo while starting compose only for selected providers', async () => {
		const providerRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-all-a-'));
		const consumerRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-all-b-'));
		await fs.mkdir(path.join(providerRepoDir, '.agent-vm'), { recursive: true });
		await fs.mkdir(path.join(consumerRepoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(providerRepoDir, '.agent-vm', 'docker-compose.yml'),
			'services: {}',
		);
		await fs.writeFile(
			path.join(consumerRepoDir, '.agent-vm', 'docker-compose.yml'),
			'services: {}',
		);
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'docker' && args[5] === 'config') {
				return { stdout: JSON.stringify({ services: { pg: {} } }), stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'up') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'ps') {
				return { stdout: 'container-1\n', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[0] === 'inspect') {
				return {
					stdout: JSON.stringify([
						{
							Config: {
								ExposedPorts: { '5432/tcp': {} },
								Labels: { 'com.docker.compose.service': 'pg' },
							},
							NetworkSettings: {
								Networks: { default: { IPAddress: '172.30.0.8' } },
							},
						},
					]),
					stderr: '',
					exitCode: 0,
				};
			}
			if (command.endsWith('/.agent-vm/run-setup.sh')) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'node') {
				return {
					stdout: JSON.stringify({ resources: {}, generated: [] }),
					stderr: '',
					exitCode: 0,
				};
			}
			throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		const result = await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [
				buildRepoResourceSetup({ repoDir: providerRepoDir, repoId: 'repo-a' }),
				buildRepoResourceSetup({ repoDir: consumerRepoDir, repoId: 'repo-b' }),
			],
			providers: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					repoDir: providerRepoDir,
					outputDir: path.join(providerRepoDir, 'output'),
					resourceName: 'pg',
					setupCommand: '.agent-vm/run-setup.sh',
					binding: { host: 'pg.local', port: 5432 },
					provider: {
						type: 'compose',
						service: 'pg',
					},
				},
			],
		});

		const composeUpCalls = execaMock.mock.calls.filter(
			([command, args]) => command === 'docker' && Array.isArray(args) && args[5] === 'up',
		);
		const setupCalls = execaMock.mock.calls.filter(([command]) =>
			command.endsWith('/.agent-vm/run-setup.sh'),
		);
		expect(composeUpCalls).toHaveLength(1);
		expect(setupCalls).toHaveLength(2);
		const setupCallWorkingDirectories = setupCalls.map(([, , options]): string => {
			const optionsValue: unknown = options;
			if (
				typeof optionsValue !== 'object' ||
				optionsValue === null ||
				!('cwd' in optionsValue) ||
				typeof optionsValue.cwd !== 'string'
			) {
				throw new Error('Expected setup call to include a string cwd option.');
			}
			return optionsValue.cwd;
		});
		expect(
			setupCallWorkingDirectories.toSorted((left, right): number => left.localeCompare(right)),
		).toEqual(
			[consumerRepoDir, providerRepoDir].toSorted((left, right): number =>
				left.localeCompare(right),
			),
		);
		expect(result.startedProviders).toHaveLength(1);
		expect(result.finalizations.map((finalization) => finalization.repoId)).toEqual([
			'repo-a',
			'repo-b',
		]);
	});

	it('cleans up a compose project when setup fails after docker compose up', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-cleanup-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ services: { pg: {} } }),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: { '5432/tcp': {} },
							Labels: { 'com.docker.compose.service': 'pg' },
						},
						NetworkSettings: {
							Networks: { default: { IPAddress: '172.30.0.8' } },
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockRejectedValueOnce(new Error('setup failed'))
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toThrow(/setup failed/u);

		expect(execaMock).toHaveBeenLastCalledWith(
			'docker',
			[
				'compose',
				'-p',
				'agent-vm-task-123-repo-a',
				'-f',
				path.join(repoDir, '.agent-vm', 'docker-compose.yml'),
				'down',
				'--remove-orphans',
			],
			expect.objectContaining({ cwd: repoDir }),
		);
	});

	it('cleans up a compose project when docker compose up wait fails', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-up-failed-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ services: { pg: {} } }),
				stderr: '',
				exitCode: 0,
			})
			.mockRejectedValueOnce(new Error('compose wait failed'))
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toThrow(/compose wait failed/u);

		expect(execaMock).toHaveBeenLastCalledWith(
			'docker',
			[
				'compose',
				'-p',
				'agent-vm-task-123-repo-a',
				'-f',
				path.join(repoDir, '.agent-vm', 'docker-compose.yml'),
				'down',
				'--remove-orphans',
			],
			expect.objectContaining({ cwd: repoDir }),
		);
	});

	it('rejects compose services attached to multiple networks instead of picking an arbitrary IP', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-network-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ services: { pg: {} } }),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: { '5432/tcp': {} },
							Labels: { 'com.docker.compose.service': 'pg' },
						},
						NetworkSettings: {
							Networks: {
								default: { IPAddress: '172.30.0.8' },
								sidecar: { IPAddress: '172.31.0.8' },
							},
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toThrow(/exactly one Docker network/u);
	});

	it('rejects selected compose services that publish host ports', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-ports-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock.mockResolvedValueOnce({
			stdout: JSON.stringify({
				services: {
					pg: {
						ports: [{ published: '5432', target: 5432 }],
					},
				},
			}),
			stderr: '',
			exitCode: 0,
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir: path.join(repoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toThrow(/must not publish host ports/u);
		expect(execaMock).not.toHaveBeenCalledWith(
			'docker',
			expect.arrayContaining(['up']),
			expect.anything(),
		);
	});

	it('reports every compose provider group that fails during parallel startup', async () => {
		const firstRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-first-fail-'));
		const secondRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-second-fail-'));
		await fs.mkdir(path.join(firstRepoDir, '.agent-vm'), { recursive: true });
		await fs.mkdir(path.join(secondRepoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(firstRepoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		await fs.writeFile(path.join(secondRepoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock.mockResolvedValue({
			stdout: JSON.stringify({
				services: {
					pg: {
						ports: [{ published: '5432', target: 5432 }],
					},
				},
			}),
			stderr: '',
			exitCode: 0,
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [
					buildRepoResourceSetup({ repoDir: firstRepoDir, repoId: 'repo-a' }),
					buildRepoResourceSetup({ repoDir: secondRepoDir, repoId: 'repo-b' }),
				],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir: firstRepoDir,
						outputDir: path.join(firstRepoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg-a.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
					{
						repoId: 'repo-b',
						repoUrl: 'https://github.com/example/repo-b.git',
						repoDir: secondRepoDir,
						outputDir: path.join(secondRepoDir, 'output'),
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg-b.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toMatchObject({
			errors: [expect.any(Error), expect.any(Error)],
		});
	});

	it('does not leak controller env into repo-controlled compose and setup subprocesses', async () => {
		process.env.AGENT_VM_SECRET_LEAK_TEST = 'do-not-leak';
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-env-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ services: { pg: {} } }),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: { '5432/tcp': {} },
							Labels: { 'com.docker.compose.service': 'pg' },
						},
						NetworkSettings: {
							Networks: { default: { IPAddress: '172.30.0.8' } },
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ resources: {}, generated: [] }),
				stderr: '',
				exitCode: 0,
			});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [buildRepoResourceSetup({ repoDir })],
			providers: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					repoDir,
					outputDir: path.join(repoDir, 'output'),
					resourceName: 'pg',
					setupCommand: '.agent-vm/run-setup.sh',
					binding: { host: 'pg.local', port: 5432 },
					provider: {
						type: 'compose',
						service: 'pg',
					},
				},
			],
		});

		for (const [command, , options] of execaMock.mock.calls) {
			if (command !== 'docker' && !command.endsWith('/.agent-vm/run-setup.sh')) {
				continue;
			}
			expect(options).toEqual(
				expect.objectContaining({
					extendEnv: false,
					timeout: expect.any(Number),
					env: expect.not.objectContaining({ AGENT_VM_SECRET_LEAK_TEST: 'do-not-leak' }),
				}),
			);
		}
	});

	it('rejects finalized generated paths that resolve outside RESOURCE_OUTPUT_DIR', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-generated-path-'));
		const outputDir = path.join(repoDir, 'output');
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(path.join(repoDir, '.agent-vm', 'docker-compose.yml'), 'services: {}');
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'docker' && args[5] === 'config') {
				return { stdout: JSON.stringify({ services: { pg: {} } }), stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'up') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[5] === 'ps') {
				return { stdout: 'container-1\n', stderr: '', exitCode: 0 };
			}
			if (command === 'docker' && args[0] === 'inspect') {
				return {
					stdout: JSON.stringify([
						{
							Config: {
								ExposedPorts: { '5432/tcp': {} },
								Labels: { 'com.docker.compose.service': 'pg' },
							},
							NetworkSettings: {
								Networks: { default: { IPAddress: '172.30.0.8' } },
							},
						},
					]),
					stderr: '',
					exitCode: 0,
				};
			}
			if (command.endsWith('/.agent-vm/run-setup.sh')) {
				await fs.symlink('/tmp', path.join(outputDir, 'escaped'));
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'node') {
				return {
					stdout: JSON.stringify({
						resources: {},
						generated: [{ kind: 'directory', path: 'escaped' }],
					}),
					stderr: '',
					exitCode: 0,
				};
			}
			if (command === 'docker' && args[5] === 'down') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			startRepoResourceProviders({
				taskId: 'task-123',
				repos: [buildRepoResourceSetup({ repoDir, outputDir })],
				providers: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						repoDir,
						outputDir,
						resourceName: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
						binding: { host: 'pg.local', port: 5432 },
						provider: {
							type: 'compose',
							service: 'pg',
						},
					},
				],
			}),
		).rejects.toThrow(/escapes RESOURCE_OUTPUT_DIR/u);
	});

	it.each([
		{
			actualKind: 'file' as const,
			declaredKind: 'directory' as const,
			message: /not a directory/u,
		},
		{ actualKind: 'directory' as const, declaredKind: 'file' as const, message: /not a file/u },
	])(
		'rejects generated paths declared as $declaredKind when the path is a $actualKind',
		async ({ actualKind, declaredKind, message }) => {
			const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-generated-kind-'));
			const outputDir = path.join(repoDir, 'output');
			await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
			execaMock.mockImplementation(async (command: string) => {
				if (command.endsWith('/.agent-vm/run-setup.sh')) {
					const artifactPath = path.join(outputDir, 'artifact');
					if (actualKind === 'directory') {
						await fs.mkdir(artifactPath, { recursive: true });
					} else {
						await fs.writeFile(artifactPath, 'artifact');
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (command === 'node') {
					return {
						stdout: JSON.stringify({
							resources: {},
							generated: [{ kind: declaredKind, path: 'artifact' }],
						}),
						stderr: '',
						exitCode: 0,
					};
				}
				throw new Error(`unexpected command: ${command}`);
			});

			const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
			await expect(
				startRepoResourceProviders({
					taskId: 'task-123',
					repos: [buildRepoResourceSetup({ repoDir, outputDir })],
					providers: [],
				}),
			).rejects.toThrow(message);
		},
	);

	it('reports all compose teardown failures as an AggregateError', async () => {
		execaMock.mockRejectedValueOnce(new Error('repo-a down failed'));
		execaMock.mockRejectedValueOnce(new Error('repo-b down failed'));

		const { stopRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		await expect(
			stopRepoResourceProviders([
				{
					repoId: 'repo-a',
					repoDir: '/tmp/repo-a',
					composeFilePath: '/tmp/repo-a/.agent-vm/docker-compose.yml',
					composeProjectName: 'agent-vm-task-repo-a',
				},
				{
					repoId: 'repo-b',
					repoDir: '/tmp/repo-b',
					composeFilePath: '/tmp/repo-b/.agent-vm/docker-compose.yml',
					composeProjectName: 'agent-vm-task-repo-b',
				},
			]),
		).rejects.toThrow(AggregateError);
	});
});
