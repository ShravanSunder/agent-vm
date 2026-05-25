/* oxlint-disable eslint/no-await-in-loop -- smoke test steps must be sequential against live VMs */
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { ensureZoneGitRepository } from '../controller/zone-git/zone-git-operations.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	disableOpenClawMcpPortalPlugin,
	rebuildWorkspacePackages,
	removeSmokeTempRoot,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type OpenClawSmokeProject,
	type SmokeHarnessRuntime,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
	if ('scopeKey' in payload) {
		throw new Error(`Lease response must not expose scopeKey: ${JSON.stringify(payload)}`);
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

function parseUnknownJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

async function readToolVmRuntimeRecordPayloads(stateDir: string): Promise<readonly unknown[]> {
	const toolLeasesDir = path.join(stateDir, 'tool-leases');
	const entries = await readdir(toolLeasesDir);
	return await Promise.all(
		entries
			.filter((entry) => entry.endsWith('.json'))
			.map(async (entry) =>
				parseUnknownJson(await readFile(path.join(toolLeasesDir, entry), 'utf8')),
			),
	);
}

async function requestZoneGitLease(options: {
	readonly controllerUrl: string;
	readonly zoneId: string;
}): Promise<ControllerLeaseResponse> {
	const response = await fetch(`${options.controllerUrl}/lease`, {
		body: JSON.stringify({
			agentId: 'smoke',
			agentWorkspaceDir: '/zone/agents/smoke',
			profileId: 'standard',
			sessionKey: 'agent:smoke:zone-git-smoke',
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
	let project: OpenClawSmokeProject | undefined;

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			if (project) {
				await removeSmokeTempRoot(project.tempRoot);
			}
		}
	});

	it('lets an agent commit in /zone and push through the OpenClaw zone_git_push tool', async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);

		project = await scaffoldOpenClawSmokeProject({
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
		await disableOpenClawMcpPortalPlugin(project.zone.gateway.config);
		await useLocalToolVmMcpPortalPackage({
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
				MCP_PORTAL_SERVER_SECRET: 'zone-git-smoke-portal-secret',
				OPENCLAW_GATEWAY_TOKEN: 'zone-git-smoke-gateway-token',
				PERPLEXITY_API_KEY: 'unused-perplexity-smoke-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [project.zone.id],
			},
		});
		const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
		if (!gatewayIngress) {
			throw new Error('OpenClaw gateway smoke did not expose an ingress URL.');
		}

		const lease = await requestZoneGitLease({
			controllerUrl: harness.controllerUrl,
			zoneId: project.zone.id,
		});
		expect(lease.workdir).toBe('/zone/agents/smoke');
		const runtimeRecords = await readToolVmRuntimeRecordPayloads(project.zone.gateway.stateDir);
		const matchingRecord = runtimeRecords.find(
			(record) => isObjectRecord(record) && record.leaseId === lease.leaseId,
		);
		expect(matchingRecord).toMatchObject({
			agentId: 'smoke',
			leaseId: lease.leaseId,
		});
		for (const runtimeRecord of runtimeRecords) {
			expect(JSON.stringify(runtimeRecord)).not.toContain('"scopeKey"');
		}
		const leasePeek = await peekLease({
			controllerUrl: harness.controllerUrl,
			leaseId: lease.leaseId,
		});
		expect(JSON.stringify(leasePeek)).not.toContain('"scopeKey"');
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
