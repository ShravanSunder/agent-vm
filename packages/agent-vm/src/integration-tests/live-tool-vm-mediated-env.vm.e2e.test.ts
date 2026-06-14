import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createStaticSecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const execFileAsync = promisify(execFile);
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

const rawGithubToken = 'real-github-token-for-mediated-env-live-test';
const rawSunToken = 'real-sun-token-for-mediated-env-live-test';
const rawMakToken = 'real-mak-token-for-mediated-env-live-test';

async function createTemporaryDirectory(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), 'agent-vm-live-mediated-env-'));
}

async function createMediatedEnvSystemConfig(
	temporaryDirectory: string,
): Promise<LoadedSystemConfig> {
	const zoneFilesDir = path.join(temporaryDirectory, 'zone-files', 'shravan');
	const stateDir = path.join(temporaryDirectory, 'state', 'shravan');

	return createLoadedSystemConfig(
		{
			cacheDir: path.join(temporaryDirectory, 'cache'),
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
					openclaw: {
						type: 'openclaw',
						buildConfig: '/project/vm-images/gateways/openclaw/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
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
					egressHosts: [
						{ host: 'api.github.com', audience: 'tool-vm' },
						{ host: 'auth.sun.test', audience: 'tool-vm' },
						{ host: 'auth.mak.test', audience: 'tool-vm' },
					],
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						config: './config/shravan/openclaw.json',
						cpus: 1,
						imageProfile: 'openclaw',
						memory: '512M',
						port: 18791,
						stateDir,
						zoneFilesDir,
					},
					id: 'shravan',
					agents: [{ id: 'shravan' }, { id: 'sun' }, { id: 'mak' }],
					secrets: {
						GITHUB_TOKEN: {
							source: 'config',
							value: rawGithubToken,
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['api.github.com'],
							agentAccess: ['shravan'],
						},
						SUN_ONLY_TOKEN: {
							source: 'config',
							value: rawSunToken,
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['auth.sun.test'],
							agentAccess: ['sun'],
						},
						MAK_ONLY_TOKEN: {
							source: 'config',
							value: rawMakToken,
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['auth.mak.test'],
							agentAccess: ['mak'],
						},
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'config',
							value: 'gateway-token-not-for-tool-vm',
							injection: 'env',
							audience: 'gateway',
						},
					},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath: path.join(temporaryDirectory, 'config', 'system.json') },
	);
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
		temporaryDirectory = await createTemporaryDirectory();
		const systemConfig = await createMediatedEnvSystemConfig(temporaryDirectory);
		const zone = systemConfig.zones[0];
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const profile = systemConfig.toolVmProfiles.standard;
		if (!profile) {
			throw new Error('Expected standard Tool VM profile.');
		}

		const hostWorkMountDir = path.join(zone.gateway.zoneFilesDir, 'agents', 'shravan');
		await mkdir(hostWorkMountDir, { recursive: true });
		const toolVm = await createToolVm(
			{
				agentId: 'shravan',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir,
				profile,
				secretResolver: createStaticSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'default-gondolin-image',
					imagePath: '',
				}),
			},
		);

		try {
			const execPlaceholderResult = await toolVm.exec('printf "%s" "$GITHUB_TOKEN"');
			expect(execPlaceholderResult.exitCode).toBe(0);
			expect(execPlaceholderResult.stdout).not.toBe('');
			expect(execPlaceholderResult.stdout).not.toBe(rawGithubToken);

			const sshAccess = await toolVm.enableSsh({ user: 'root' });
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
			await toolVm.close();
		}

		const sunWorkMountDir = path.join(zone.gateway.zoneFilesDir, 'agents', 'sun');
		await mkdir(sunWorkMountDir, { recursive: true });
		const sunToolVm = await createToolVm(
			{
				agentId: 'sun',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: sunWorkMountDir,
				profile,
				secretResolver: createStaticSecretResolver({}),
				systemConfig,
				tcpSlot: 1,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'default-gondolin-image',
					imagePath: '',
				}),
			},
		);

		try {
			const scopedPlaceholderResult = await sunToolVm.exec(
				'printf "%s|%s" "${SUN_ONLY_TOKEN-__unset__}" "${MAK_ONLY_TOKEN-__unset__}"',
			);
			expect(scopedPlaceholderResult.exitCode).toBe(0);
			const [sunPlaceholder, makPlaceholder] = scopedPlaceholderResult.stdout.split('|');
			expect(sunPlaceholder).toBeTruthy();
			expect(sunPlaceholder).not.toBe(rawSunToken);
			expect(makPlaceholder).toBe('__unset__');
		} finally {
			await sunToolVm.close();
		}

		const makWorkMountDir = path.join(zone.gateway.zoneFilesDir, 'agents', 'mak');
		await mkdir(makWorkMountDir, { recursive: true });
		const makToolVm = await createToolVm(
			{
				agentId: 'mak',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: makWorkMountDir,
				profile,
				secretResolver: createStaticSecretResolver({}),
				systemConfig,
				tcpSlot: 2,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'default-gondolin-image',
					imagePath: '',
				}),
			},
		);

		try {
			const scopedPlaceholderResult = await makToolVm.exec(
				'printf "%s|%s" "${SUN_ONLY_TOKEN-__unset__}" "${MAK_ONLY_TOKEN-__unset__}"',
			);
			expect(scopedPlaceholderResult.exitCode).toBe(0);
			const [sunPlaceholder, makPlaceholder] = scopedPlaceholderResult.stdout.split('|');
			expect(sunPlaceholder).toBe('__unset__');
			expect(makPlaceholder).toBeTruthy();
			expect(makPlaceholder).not.toBe(rawMakToken);
		} finally {
			await makToolVm.close();
		}
	}, 180_000);
});
