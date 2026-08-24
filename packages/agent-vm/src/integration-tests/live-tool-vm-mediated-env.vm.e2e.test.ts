import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { createStaticSecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity, sleep } from '../shared/managed-vm-process.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';
import { prepareGatewayE2eProjectImages } from './e2e-harness.js';
import { scaffoldHermesE2eProject } from './hermes-e2e-harness.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const execFileAsync = promisify(execFile);
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const managedVmRuntimeComposition = createManagedVmRuntimeComposition();

const rawGithubToken = 'real-github-token-for-mediated-env-live-test';

async function captureStartedVmProcess(managedVm: ManagedVm): Promise<ManagedVmProcessTarget> {
	const hostPid = managedVm.getHostProcessId();
	if (hostPid === null) {
		throw new Error(`Expected started VM '${managedVm.id}' to expose its host pid.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(`Expected started VM '${managedVm.id}' process identity.`);
	}
	return { hostPid, processIdentity, vmId: managedVm.id };
}

async function terminateVmRuntime(
	managedVm: ManagedVm,
	target: ManagedVmProcessTarget,
): Promise<void> {
	await terminateLiveManagedVm({
		contextLabel: 'Tool VM mediated environment cleanup',
		exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
		sleep,
		target,
		vm: managedVm,
	});
}

async function createMediatedEnvSystemConfig(options: {
	readonly cacheDir: string;
	readonly temporaryDirectory: string;
	readonly toolVmBuildConfigPath: string;
}): Promise<LoadedSystemConfig> {
	const systemConfig = createLoadedSystemConfig(
		{
			schemaVersion: 2,
			storageRootDir: options.temporaryDirectory,
			host: {
				controllerPort: 18800,
				projectNamespace: 'mediated-env-live',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env' },
				},
			},
			imageProfiles: {
				gateways: {
					hermes: {
						type: 'hermes',
						buildConfig: '/test-fixtures/gateway-build-config.jsonc',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: options.toolVmBuildConfigPath,
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '512M',
				},
			},
			zones: [
				{
					agentToolVmProfiles: {},
					defaultToolVmProfile: 'standard',
					egressHosts: [{ host: 'api.github.com', audience: 'tool-vm' }],
					gateway: {
						type: 'hermes',
						config: './config/shravan/config.yaml',
						cpus: 1,
						imageProfile: 'hermes',
						memory: '512M',
						port: 18791,
						profilesByAgent: { shravan: 'shravan' },
						profileSecretProjectionsByAgent: {
							shravan: {
								API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
							},
						},
					},
					id: 'shravan',
					agents: [{ id: 'shravan' }],
					secrets: {
						API_SERVER_KEY: {
							source: 'config',
							value: 'test-root-api-server-key',
							injection: 'env',
							audience: 'gateway',
						},
						API_SERVER_KEY_SHRAVAN: {
							source: 'environment',
							envVar: 'API_SERVER_KEY_SHRAVAN',
							injection: 'env',
							audience: 'gateway',
						},
						DISCORD_BOT_TOKEN: {
							source: 'environment',
							envVar: 'DISCORD_BOT_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
						GITHUB_TOKEN: {
							source: 'config',
							value: rawGithubToken,
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['api.github.com'],
							agentAccess: ['shravan'],
						},
					},
				},
			],
		},
		{ systemConfigPath: path.join(options.temporaryDirectory, 'config', 'system.json') },
	);
	return { ...systemConfig, cacheDir: options.cacheDir };
}

async function runToolVmSshCommand(options: {
	readonly host: string;
	readonly identityFile: string;
	readonly port: number;
	readonly user: string;
}): Promise<string> {
	const { stdout } = await execFileAsync('ssh', [
		'-4',
		'-p',
		String(options.port),
		'-i',
		options.identityFile,
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		'-o',
		'BatchMode=yes',
		'-o',
		'ConnectTimeout=10',
		`${options.user}@${options.host}`,
		'/bin/sh -c \'printf "%s" "$GITHUB_TOKEN"\' gondolin-sandbox-fs',
	]);
	return stdout;
}

describeLiveVmIntegration('live: Tool VM mediated placeholder environment', () => {
	let temporaryDirectory: string | undefined;

	afterAll(async () => {
		if (temporaryDirectory) {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('makes scoped http-mediated placeholders visible only to the allowed Tool VM agent', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['shravan'],
			architecture: process.arch === 'arm64' ? 'aarch64' : 'x86_64',
			prefix: 'agent-vm-live-mediated-env-',
			zoneId: 'shravan',
		});
		temporaryDirectory = project.tempRoot;
		await prepareGatewayE2eProjectImages({
			project,
			runBuild: async ({ systemConfig: preparedSystemConfig }) => {
				await runBuildCommand({
					skipObservability: true,
					systemConfig: {
						...preparedSystemConfig,
						imageProfiles: {
							...preparedSystemConfig.imageProfiles,
							gateways: {},
						},
					},
				});
			},
		});
		const preparedToolVmImageProfile = project.systemConfig.imageProfiles.toolVms.default;
		if (preparedToolVmImageProfile === undefined) {
			throw new Error('Expected the E2E project to configure a default Tool VM image.');
		}
		const systemConfig = await createMediatedEnvSystemConfig({
			cacheDir: project.systemConfig.cacheDir,
			temporaryDirectory,
			toolVmBuildConfigPath: preparedToolVmImageProfile.buildConfig,
		});
		const zone = systemConfig.zones[0];
		if (zone?.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes test zone.');
		}
		const profile = systemConfig.toolVmProfiles.standard;
		if (!profile) {
			throw new Error('Expected standard Tool VM profile.');
		}

		const hostAgentGitDirectoryRoot = path.join(
			zone.gateway.zoneRuntimeDir,
			'gitdirs',
			'agents',
			'shravan',
		);
		const hostAgentRoot = path.join(zone.gateway.zoneFilesDir, 'agents', 'shravan');
		await Promise.all([
			mkdir(hostAgentGitDirectoryRoot, { recursive: true }),
			mkdir(hostAgentRoot, { recursive: true }),
		]);
		const runtimeComposition = managedVmRuntimeComposition;
		const toolVm = await createToolVm(
			{
				agentId: 'shravan',
				cacheDir: systemConfig.cacheDir,
				profile,
				rootBinding: {
					hostGitDirectoryRoot: hostAgentGitDirectoryRoot,
					hostWorkspaceRoot: hostAgentRoot,
					kind: 'managed-agent-workspace',
				},
				secretResolver: createStaticSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			runtimeComposition,
		);
		const terminationTarget = await captureStartedVmProcess(toolVm);
		let sshAccess: Awaited<ReturnType<ManagedVm['enableSsh']>> | undefined;

		try {
			const execPlaceholderResult = await toolVm.exec('printf "%s" "$GITHUB_TOKEN"');
			expect(execPlaceholderResult.exitCode).toBe(0);
			expect(execPlaceholderResult.stdout).not.toBe('');
			expect(execPlaceholderResult.stdout).not.toBe(rawGithubToken);

			sshAccess = await toolVm.enableSsh({ user: 'root' });
			if (!sshAccess.identityFile || !sshAccess.user) {
				throw new Error('Expected Tool VM SSH access to include identityFile and user.');
			}
			const sshPlaceholder = await runToolVmSshCommand({
				host: sshAccess.host,
				identityFile: sshAccess.identityFile,
				port: sshAccess.port,
				user: sshAccess.user,
			});

			expect(sshPlaceholder).toBe(execPlaceholderResult.stdout);
			expect(sshPlaceholder).not.toBe(rawGithubToken);
		} finally {
			await sshAccess?.close();
			await terminateVmRuntime(toolVm, terminationTarget);
		}
	}, 180_000);
});
