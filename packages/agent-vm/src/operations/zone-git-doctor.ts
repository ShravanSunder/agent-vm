import { stat } from 'node:fs/promises';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { getZoneGitStatus } from '../controller/zone-git/zone-git-operations.js';
import {
	isOpenClawZoneGitConfigured,
	resolveZoneGitPaths,
} from '../controller/zone-git/zone-git-paths.js';
import type { DoctorCheck } from './doctor.js';

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

export async function collectZoneGitDoctorChecks(options: {
	readonly githubToken: string | null;
	readonly githubTokenResolutionError?: string | undefined;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const zone of options.systemConfig.zones) {
		if (!isOpenClawZoneGitConfigured(zone)) {
			continue;
		}
		const zoneGitPaths = resolveZoneGitPaths({
			runtimeDir: options.systemConfig.runtimeDir,
			zoneId: zone.id,
		});
		const hasGithubToken = options.githubToken !== null;
		checks.push({
			name: `zone-git-github-token-${zone.id}`,
			ok: hasGithubToken,
			hint: hasGithubToken
				? 'host GitHub token available to controller'
				: options.githubTokenResolutionError !== undefined
					? `Configured host.githubToken could not be resolved: ${options.githubTokenResolutionError}`
					: `Set host.githubToken so the controller can push zone '${zone.id}' without exposing credentials to VMs.`,
		});
		// oxlint-disable-next-line no-await-in-loop -- doctor output should stay zone ordered
		const initialized = await pathExists(zoneGitPaths.hostGitDir);
		checks.push({
			name: `zone-git-initialized-${zone.id}`,
			ok: initialized,
			hint: initialized
				? zoneGitPaths.hostGitDir
				: `Run agent-vm zone-git init --zone ${zone.id}; expected ${zoneGitPaths.hostGitDir}`,
		});
		if (!initialized) {
			checks.push(
				{
					name: `zone-git-clean-${zone.id}`,
					ok: false,
					hint: `Initialize zone Git before checking cleanliness: agent-vm zone-git init --zone ${zone.id}`,
				},
				{
					name: `zone-git-pushed-${zone.id}`,
					ok: false,
					hint: `Initialize zone Git before checking pushed state: agent-vm zone-git init --zone ${zone.id}`,
				},
			);
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- doctor output should stay zone ordered
			const status = await getZoneGitStatus({
				branch: zone.gateway.zoneGit.remote.branch,
				...(options.githubToken ? { githubToken: options.githubToken } : {}),
				remoteUrl: zone.gateway.zoneGit.remote.repoUrl,
				runtimeDir: options.systemConfig.runtimeDir,
				zoneFilesDir: zone.gateway.zoneFilesDir,
				zoneId: zone.id,
			});
			checks.push(
				{
					name: `zone-git-clean-${zone.id}`,
					ok: !status.dirty,
					hint: status.dirty
						? `Zone '${zone.id}' has uncommitted changes. Run git status, git add, and git commit.`
						: 'zone Git worktree clean',
				},
				{
					name: `zone-git-pushed-${zone.id}`,
					ok: status.aheadOfRemote === 0,
					hint:
						status.aheadOfRemote === 0
							? 'zone Git commits pushed'
							: `Zone '${zone.id}' has ${String(status.aheadOfRemote)} unpushed commit(s). Run agent-vm zone-git push --zone ${zone.id}.`,
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push(
				{
					name: `zone-git-clean-${zone.id}`,
					ok: false,
					hint: `Could not inspect zone Git worktree: ${message}`,
				},
				{
					name: `zone-git-pushed-${zone.id}`,
					ok: false,
					hint: `Could not inspect zone Git pushed state: ${message}`,
				},
			);
		}
	}
	return checks;
}
