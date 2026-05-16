/* oxlint-disable eslint/no-await-in-loop -- smoke test steps must be sequential against live VMs */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { ensureZoneGitRepository } from '../controller/zone-git/zone-git-operations.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	rebuildWorkspacePackages,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type SmokeHarnessRuntime,
	useLocalOpenClawPluginGatewayImage,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawZoneGitSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawZoneGitSmoke = runOpenClawZoneGitSmoke ? describe : describe.skip;

interface ControllerLeaseResponse {
	readonly leaseId: string;
	readonly ssh: {
		readonly identityPem: string;
	};
	readonly workdir: string;
}

interface ControllerLeasePeekResponse {
	readonly ssh: {
		readonly host: string;
		readonly port: number;
		readonly user: string;
	};
}

function assertControllerLeaseResponse(
	payload: unknown,
): asserts payload is ControllerLeaseResponse {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Lease response must be an object.');
	}
	const response = payload as Partial<ControllerLeaseResponse>;
	if (
		typeof response.leaseId !== 'string' ||
		typeof response.workdir !== 'string' ||
		typeof response.ssh !== 'object' ||
		response.ssh === null ||
		typeof response.ssh.identityPem !== 'string'
	) {
		throw new Error(`Lease response had unexpected shape: ${JSON.stringify(payload)}`);
	}
}

function assertControllerLeasePeekResponse(
	payload: unknown,
): asserts payload is ControllerLeasePeekResponse {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Lease peek response must be an object.');
	}
	const response = payload as Partial<ControllerLeasePeekResponse>;
	if (
		typeof response.ssh !== 'object' ||
		response.ssh === null ||
		typeof response.ssh.host !== 'string' ||
		typeof response.ssh.port !== 'number' ||
		typeof response.ssh.user !== 'string'
	) {
		throw new Error(`Lease peek response had unexpected shape: ${JSON.stringify(payload)}`);
	}
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${String(response.status)}: ${responseBody}`);
	}
	return JSON.parse(responseBody) as unknown;
}

async function requestZoneGitLease(options: {
	readonly controllerUrl: string;
	readonly zoneId: string;
}): Promise<ControllerLeaseResponse> {
	const response = await fetch(`${options.controllerUrl}/lease`, {
		body: JSON.stringify({
			agentWorkspaceDir: '/zone/agents/smoke',
			profileId: 'standard',
			scopeKey: 'agent:smoke',
			workMountDir: '/zone/agents/smoke',
			zoneId: options.zoneId,
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});
	const payload = await readJsonResponse(response);
	assertControllerLeaseResponse(payload);
	return payload;
}

async function peekLease(options: {
	readonly controllerUrl: string;
	readonly leaseId: string;
}): Promise<ControllerLeasePeekResponse> {
	const response = await fetch(`${options.controllerUrl}/lease/${options.leaseId}/peek`);
	const payload = await readJsonResponse(response);
	assertControllerLeasePeekResponse(payload);
	return payload;
}

async function createSshIdentityFile(options: {
	readonly identityPem: string;
	readonly tempRoot: string;
}): Promise<string> {
	const identityFilePath = path.join(options.tempRoot, 'zone-git-smoke-identity.pem');
	await writeFile(identityFilePath, options.identityPem, { encoding: 'utf8', mode: 0o600 });
	await chmod(identityFilePath, 0o600);
	return identityFilePath;
}

async function execSsh(options: {
	readonly command: string;
	readonly identityFilePath: string;
	readonly ssh: ControllerLeasePeekResponse['ssh'];
}): Promise<string> {
	const result = await execa(
		'ssh',
		[
			'-p',
			String(options.ssh.port),
			'-i',
			options.identityFilePath,
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-o',
			'BatchMode=yes',
			'-o',
			'ConnectTimeout=10',
			`${options.ssh.user}@${options.ssh.host}`,
			options.command,
		],
		{ timeout: 60_000 },
	);
	return result.stdout.trim();
}

async function execGitInToolVm(options: {
	readonly command: string;
	readonly identityFilePath: string;
	readonly ssh: ControllerLeasePeekResponse['ssh'];
}): Promise<string> {
	return await execSsh({
		command: `git -C /zone/agents/smoke ${options.command}`,
		identityFilePath: options.identityFilePath,
		ssh: options.ssh,
	});
}

describeOpenClawZoneGitSmoke('smoke: OpenClaw zone Git workflow', () => {
	let harness: SmokeHarnessRuntime | undefined;

	afterAll(async () => {
		await harness?.close();
	});

	it('lets an agent commit in /zone and push through the OpenClaw zone_git_push tool', async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);

		const project = await scaffoldOpenClawSmokeProject({
			agents: ['smoke'],
			architecture,
			prefix: 'openclaw-zone-git-smoke-',
			zoneId: 'zone-git-smoke',
		});
		await useLocalOpenClawPluginGatewayImage({
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		const remoteGitDir = path.join(project.tempRoot, 'zone-files-remote.git');
		await execa('git', ['init', '--bare', remoteGitDir]);
		project.systemConfig.host.githubToken = {
			source: 'environment',
			envVar: 'AGENT_VM_ZONE_GIT_SMOKE_GITHUB_TOKEN',
		};
		project.zone.gateway.zoneGit = {
			remote: {
				branch: 'main',
				repoUrl: remoteGitDir,
			},
		};
		await mkdir(path.join(project.zone.gateway.zoneFilesDir, 'agents', 'smoke'), {
			recursive: true,
		});
		await ensureZoneGitRepository({
			branch: 'main',
			remoteUrl: remoteGitDir,
			runtimeDir: project.systemConfig.runtimeDir,
			zoneFilesDir: project.zone.gateway.zoneFilesDir,
			zoneId: project.zone.id,
		});
		await runBuildCommand({
			forceRebuild: true,
			systemConfig: project.systemConfig,
		});

		harness = await startSmokeControllerRuntime({
			secrets: {
				AGENT_VM_ZONE_GIT_SMOKE_GITHUB_TOKEN: 'local-remote-token-not-for-tool-vm',
				GITHUB_TOKEN: 'local-remote-token-not-for-tool-vm',
				OPENCLAW_GATEWAY_TOKEN: 'zone-git-smoke-gateway-token',
				PERPLEXITY_API_KEY: 'unused-perplexity-smoke-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [project.zone.id],
			},
		});
		const gatewayIngress = harness.runtime.zones[0]?.ingress;
		if (!gatewayIngress) {
			throw new Error('OpenClaw gateway smoke did not expose an ingress URL.');
		}

		const lease = await requestZoneGitLease({
			controllerUrl: harness.controllerUrl,
			zoneId: project.zone.id,
		});
		expect(lease.workdir).toBe('/zone/agents/smoke');
		const leasePeek = await peekLease({
			controllerUrl: harness.controllerUrl,
			leaseId: lease.leaseId,
		});
		const identityFilePath = await createSshIdentityFile({
			identityPem: lease.ssh.identityPem,
			tempRoot: project.tempRoot,
		});

		await expect(
			execGitInToolVm({
				command: 'rev-parse --show-toplevel',
				identityFilePath,
				ssh: leasePeek.ssh,
			}),
		).resolves.toBe('/zone');
		await expect(
			execSsh({
				command:
					'test -z "${AGENT_VM_ZONE_GIT_SMOKE_GITHUB_TOKEN:-}" && test -z "${GITHUB_TOKEN:-}"',
				identityFilePath,
				ssh: leasePeek.ssh,
			}),
		).resolves.toBe('');
		await execGitInToolVm({
			command: 'config user.email smoke@example.com',
			identityFilePath,
			ssh: leasePeek.ssh,
		});
		await execGitInToolVm({
			command: 'config user.name zone-git-smoke',
			identityFilePath,
			ssh: leasePeek.ssh,
		});
		await execSsh({
			command: "printf 'zone git smoke\\n' > /zone/agents/smoke/SMOKE.md",
			identityFilePath,
			ssh: leasePeek.ssh,
		});
		await execGitInToolVm({
			command: 'add SMOKE.md',
			identityFilePath,
			ssh: leasePeek.ssh,
		});
		await execGitInToolVm({
			command: "commit -m 'docs: smoke zone git'",
			identityFilePath,
			ssh: leasePeek.ssh,
		});
		const localHead = await execGitInToolVm({
			command: 'rev-parse HEAD',
			identityFilePath,
			ssh: leasePeek.ssh,
		});

		const gatewayClient = createGatewayApiClient({
			gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
			token: 'zone-git-smoke-gateway-token',
		});
		await expect(
			gatewayClient.invokeTool({
				agentId: 'smoke',
				args: { expectedHead: localHead },
				tool: 'zone_git_push',
			}),
		).resolves.toBeTruthy();

		const remoteHead = (
			await execa('git', ['--git-dir', remoteGitDir, 'rev-parse', 'refs/heads/main'])
		).stdout.trim();
		expect(remoteHead).toBe(localHead);

		const statusPayload = await readJsonResponse(
			await fetch(`${harness.controllerUrl}/zones/${project.zone.id}/zone-git/status`),
		);
		expect(statusPayload).toMatchObject({
			aheadOfRemote: 0,
			dirty: false,
			localHead,
			remoteHead: localHead,
		});
	}, 900_000);
});
