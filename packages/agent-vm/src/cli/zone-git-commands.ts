import type { LoadedSystemConfig } from '../config/system-config.js';
import { resolveControllerGithubToken } from '../controller/controller-runtime-support.js';
import {
	ensureZoneGitRepository,
	getZoneGitStatus,
	pushZoneGit,
	type ZoneGitOperationConfig,
	type ZoneGitPushResult,
	type ZoneGitStatus,
} from '../controller/zone-git/zone-git-operations.js';
import { isOpenClawZoneGitConfigured } from '../controller/zone-git/zone-git-paths.js';
import {
	writeJson,
	type CliDependencies,
	type CliIo,
	createResolverFromSystemConfig,
	requireZone,
} from './agent-vm-cli-support.js';

export type ZoneGitCommandAction = 'init' | 'push' | 'status';

export interface RunZoneGitCommandOptions {
	readonly action: ZoneGitCommandAction;
	readonly dependencies: Pick<
		CliDependencies,
		'createSecretResolver' | 'resolveServiceAccountToken'
	>;
	readonly io: CliIo;
	readonly json: boolean;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}

function formatYesNo(value: boolean): 'no' | 'yes' {
	return value ? 'yes' : 'no';
}

function writeZoneGitStatus(io: CliIo, zoneId: string, status: ZoneGitStatus): void {
	io.stdout.write(
		[
			`zone git ${zoneId}`,
			`  branch       ${status.branch}`,
			`  initialized  ${formatYesNo(status.initialized)}`,
			`  dirty        ${formatYesNo(status.dirty)}`,
			`  ahead        ${String(status.aheadOfRemote)}`,
			`  behind       ${String(status.behindRemote)}`,
			`  localHead    ${status.localHead ?? '-'}`,
			`  remoteHead   ${status.remoteHead ?? '-'}`,
			'',
		].join('\n'),
	);
}

function writeZoneGitPushResult(io: CliIo, zoneId: string, result: ZoneGitPushResult): void {
	io.stdout.write(
		[
			`zone git ${zoneId} pushed`,
			`  branch       ${result.branch}`,
			`  localHead    ${result.localHead}`,
			`  remoteHead   ${result.remoteHead}`,
			`  commits      ${String(result.pushedCommits.length)}`,
			'',
		].join('\n'),
	);
}

async function resolveZoneGitConfig(options: {
	readonly dependencies: Pick<
		CliDependencies,
		'createSecretResolver' | 'resolveServiceAccountToken'
	>;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}): Promise<ZoneGitOperationConfig> {
	const zone = requireZone(options.systemConfig, options.zoneId);
	if (!isOpenClawZoneGitConfigured(zone)) {
		throw new Error(`Zone '${zone.id}' does not have OpenClaw zoneGit configured.`);
	}
	const secretResolver = await createResolverFromSystemConfig(
		options.systemConfig,
		options.dependencies,
	);
	const githubToken = await resolveControllerGithubToken(options.systemConfig, secretResolver);
	if (!githubToken) {
		throw new Error(
			`zoneGit for zone '${zone.id}' requires host.githubToken so the controller can push without exposing credentials to VMs.`,
		);
	}
	return {
		branch: zone.gateway.zoneGit.remote.branch,
		githubToken,
		remoteUrl: zone.gateway.zoneGit.remote.repoUrl,
		runtimeDir: options.systemConfig.runtimeDir,
		zoneFilesDir: zone.gateway.zoneFilesDir,
		zoneId: zone.id,
	};
}

export async function runZoneGitCommand(options: RunZoneGitCommandOptions): Promise<void> {
	const zoneGitConfig = await resolveZoneGitConfig({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	if (options.action === 'init') {
		await ensureZoneGitRepository(zoneGitConfig);
		const status = await getZoneGitStatus(zoneGitConfig);
		if (options.json) {
			writeJson(options.io, { zoneId: options.zoneId, status });
			return;
		}
		writeZoneGitStatus(options.io, options.zoneId, status);
		return;
	}
	if (options.action === 'status') {
		const status = await getZoneGitStatus(zoneGitConfig);
		if (options.json) {
			writeJson(options.io, { zoneId: options.zoneId, status });
			return;
		}
		writeZoneGitStatus(options.io, options.zoneId, status);
		return;
	}

	const status = await getZoneGitStatus(zoneGitConfig);
	if (!status.localHead) {
		throw new Error(`Zone '${options.zoneId}' has no local zone Git commits to push.`);
	}
	const pushResult = await pushZoneGit({
		...zoneGitConfig,
		expectedHead: status.localHead,
	});
	if (options.json) {
		writeJson(options.io, { zoneId: options.zoneId, result: pushResult });
		return;
	}
	writeZoneGitPushResult(options.io, options.zoneId, pushResult);
}
