import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import { dim, green, red } from 'ansis';
import { execa } from 'execa';

import type { ManagedImageSource } from '../build/managed-image-dockerfile.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { resolveControllerGithubToken } from '../controller/controller-runtime-support.js';
import { isOpenClawZoneGitConfigured } from '../controller/zone-git/zone-git-paths.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import {
	collectOpenClawConfigChecks,
	type ConfigValidationCheck,
	resolveProjectCheckoutPath,
} from '../operations/config-validation.js';
import { collectVmHostSystemDoctorCheck, type DoctorCheck } from '../operations/doctor.js';
import { collectOpenClawDeploymentDoctorChecks } from '../operations/openclaw-deployment-doctor.js';
import { collectZoneGitDoctorChecks } from '../operations/zone-git-doctor.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	readZoneFlag,
	requireZone,
	resolveControllerBaseUrl,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunControllerOperationCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly subcommand:
		| 'credentials'
		| 'destroy'
		| 'doctor'
		| 'logs'
		| 'status'
		| 'stop'
		| 'upgrade';
	readonly systemConfig: LoadedSystemConfig;
}

interface ImageProfileDoctorTarget {
	readonly buildConfig: string;
	readonly buildConfigCheckName: string;
	readonly checkName: string;
	readonly dockerfile?: string;
	readonly source?: ManagedImageSource;
	readonly type: 'openclaw' | 'toolVm' | 'worker';
}

interface DoctorCommandResult {
	readonly checks: readonly DoctorCheck[];
	readonly failed: number;
	readonly ok: boolean;
	readonly passed: number;
	readonly summary: string;
}

const defaultPassingPreviewLimit = 3;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createImageProfileDoctorTarget(
	checkName: string,
	buildConfigCheckName: string,
	type: ImageProfileDoctorTarget['type'],
	buildConfig: string,
	dockerfile: string | undefined,
	source: ManagedImageSource | undefined,
): ImageProfileDoctorTarget {
	const target: {
		buildConfig: string;
		buildConfigCheckName: string;
		checkName: string;
		dockerfile?: string;
		source?: ManagedImageSource;
		type: ImageProfileDoctorTarget['type'];
	} = { buildConfig, buildConfigCheckName, checkName, type };
	if (dockerfile !== undefined) {
		target.dockerfile = dockerfile;
	}
	if (source !== undefined) {
		target.source = source;
	}
	return target;
}

function imageProfileHasProducer(imageProfileTarget: ImageProfileDoctorTarget): boolean {
	return (
		imageProfileTarget.dockerfile !== undefined || imageProfileTarget.source?.kind === 'managedBase'
	);
}

function formatImageProfileProducerHint(
	imageProfileTarget: ImageProfileDoctorTarget,
	imageName: string,
): string {
	if (imageProfileTarget.dockerfile !== undefined) {
		return imageProfileTarget.dockerfile;
	}
	if (imageProfileTarget.source !== undefined) {
		return (
			imageProfileTarget.source.overlay ??
			`source=${imageProfileTarget.source.kind} base=${imageProfileTarget.source.base}`
		);
	}
	return `pullPolicy=never requires a dockerfile producer for ${imageName}`;
}

async function collectAvailableBinaryNames(
	requiredBinaries: readonly string[],
	localBinaryDirectory?: string,
): Promise<ReadonlySet<string>> {
	const availableBinaries = new Set<string>();
	for (const binary of requiredBinaries) {
		try {
			if (binary.includes('/')) {
				// oxlint-disable-next-line no-await-in-loop -- stable check order makes doctor output deterministic
				await fs.access(binary, constants.X_OK);
			} else {
				// oxlint-disable-next-line no-await-in-loop -- stable check order makes doctor output deterministic
				await execa('which', [binary], {
					...(localBinaryDirectory
						? { env: { PATH: `${localBinaryDirectory}:${process.env.PATH ?? ''}` } }
						: {}),
					stderr: 'ignore',
					stdout: 'ignore',
				});
			}
			availableBinaries.add(binary);
		} catch {
			// Binary not found on the host.
		}
	}
	return availableBinaries;
}

async function collectCommandOutput(
	command: string,
	arguments_: readonly string[],
): Promise<string | undefined> {
	try {
		const result = await execa(command, [...arguments_]);
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function collectDockerDaemonReady(availableBinaries: ReadonlySet<string>): Promise<boolean> {
	if (!availableBinaries.has('docker')) {
		return false;
	}
	try {
		await execa('docker', ['info'], { stderr: 'ignore', stdout: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

async function collectImageProfileDockerfileChecks(
	systemConfig: LoadedSystemConfig,
	_canRunDockerImages: boolean,
): Promise<readonly DoctorCheck[]> {
	const imageProfileTargets: readonly ImageProfileDoctorTarget[] = [
		...Object.entries(systemConfig.imageProfiles.gateways).map(([profileName, profile]) =>
			createImageProfileDoctorTarget(
				`gateway-image-profile-${profileName}-dockerfile`,
				`gateway-image-profile-${profileName}-build-config`,
				profile.type,
				profile.buildConfig,
				profile.dockerfile,
				profile.source,
			),
		),
		...Object.entries(systemConfig.imageProfiles.toolVms).map(([profileName, profile]) =>
			createImageProfileDoctorTarget(
				`tool-vm-image-profile-${profileName}-dockerfile`,
				`tool-vm-image-profile-${profileName}-build-config`,
				profile.type,
				profile.buildConfig,
				profile.dockerfile,
				profile.source,
			),
		),
	];
	const checks: DoctorCheck[] = [];

	for (const imageProfileTarget of imageProfileTargets) {
		let buildConfig: unknown;
		try {
			// oxlint-disable-next-line no-await-in-loop -- stable doctor output order follows system.json order
			buildConfig = await loadJsonConfigFile(imageProfileTarget.buildConfig);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({
				name: imageProfileTarget.buildConfigCheckName,
				ok: false,
				hint: `Cannot read ${imageProfileTarget.buildConfig}: ${message}`,
			});
			continue;
		}

		const ociConfig = isObjectRecord(buildConfig) ? buildConfig.oci : undefined;
		if (!isObjectRecord(ociConfig) || ociConfig.pullPolicy !== 'never') {
			if (imageProfileTarget.type !== 'openclaw' || !imageProfileHasProducer(imageProfileTarget)) {
				continue;
			}
		}

		const imageName =
			isObjectRecord(ociConfig) && typeof ociConfig.image === 'string'
				? ociConfig.image
				: 'configured image';
		checks.push({
			name: imageProfileTarget.checkName,
			ok: imageProfileHasProducer(imageProfileTarget),
			hint: formatImageProfileProducerHint(imageProfileTarget, imageName),
		});
	}

	return checks;
}

async function collectWorkerGatewayConfigChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const zone of systemConfig.zones) {
		if (zone.gateway.type !== 'worker') {
			continue;
		}
		const workerConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			await loadWorkerConfigDraft(workerConfigPath);
			checks.push({
				name: `worker-config-${zone.id}`,
				ok: true,
				hint: workerConfigPath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({
				name: `worker-config-${zone.id}`,
				ok: false,
				hint: message,
			});
		}
	}
	return checks;
}

function convertConfigValidationChecksToDoctorChecks(
	checks: readonly ConfigValidationCheck[],
): readonly DoctorCheck[] {
	return checks.map(
		(check) =>
			({
				name: check.name,
				ok: check.ok,
				...(check.hint ? { hint: check.hint } : {}),
			}) satisfies DoctorCheck,
	);
}

function formatDoctorCheckStatus(check: DoctorCheck): string {
	return check.ok ? green('PASS') : red('FAIL');
}

function formatDoctorCheckDetails(check: DoctorCheck): readonly string[] {
	const details: string[] = [];
	if (check.value !== undefined) {
		details.push(`  value: ${String(check.value)}`);
	}
	if (check.hint !== undefined) {
		const [firstLine, ...remainingLines] = check.hint.split('\n');
		details.push(`  hint: ${firstLine ?? ''}`);
		for (const line of remainingLines) {
			details.push(`        ${line}`);
		}
	}
	return details;
}

function appendDoctorCheckLines(lines: string[], checks: readonly DoctorCheck[]): void {
	for (const check of checks) {
		lines.push(`${formatDoctorCheckStatus(check)} ${check.name}`);
		lines.push(...formatDoctorCheckDetails(check));
	}
}

function appendDoctorPassingPreviewLines(lines: string[], checks: readonly DoctorCheck[]): void {
	const visibleChecks = checks.slice(0, defaultPassingPreviewLimit);
	for (const check of visibleChecks) {
		lines.push(`${formatDoctorCheckStatus(check)} ${check.name}`);
	}
	const hiddenCheckCount = checks.length - visibleChecks.length;
	if (hiddenCheckCount > 0) {
		const checkLabel = hiddenCheckCount === 1 ? 'check' : 'checks';
		lines.push(
			dim(
				`... ${hiddenCheckCount} more passing ${checkLabel} hidden. Use --show-passed to show all.`,
			),
		);
	}
}

function writeDoctorText(
	io: CliIo,
	result: DoctorCommandResult,
	options: { readonly showPassed: boolean },
): void {
	const failedChecks = result.checks.filter((check) => !check.ok);
	const passedChecks = result.checks.filter((check) => check.ok);
	const statusLine =
		result.failed === 0
			? green(`${result.passed} passed, 0 failed`)
			: red(`${result.failed} failed`) + dim(', ') + green(`${result.passed} passed`);
	const lines = ['agent-vm doctor', '', statusLine, ''];
	if (failedChecks.length > 0) {
		lines.push(`Failures (${failedChecks.length})`);
		appendDoctorCheckLines(lines, failedChecks);
	}
	if (options.showPassed && passedChecks.length > 0) {
		if (failedChecks.length > 0) {
			lines.push('');
		}
		lines.push(green(`Passing (${passedChecks.length})`));
		appendDoctorCheckLines(lines, passedChecks);
	} else if (passedChecks.length > 0) {
		if (failedChecks.length > 0) {
			lines.push('');
		}
		lines.push(green(`Passing (${passedChecks.length})`));
		appendDoctorPassingPreviewLines(lines, passedChecks);
	}
	io.stdout.write(`${lines.join('\n')}\n`);
}

export async function runControllerOperationCommand(
	options: RunControllerOperationCommandOptions,
): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});

	switch (options.subcommand) {
		case 'doctor': {
			const availableBinaries = await collectAvailableBinaryNames(
				[
					'qemu-system-aarch64',
					'qemu-system-x86_64',
					'qemu-img',
					'docker',
					'op',
					'security',
					'mke2fs',
					'mkfs.ext4',
					'/opt/homebrew/opt/e2fsprogs/sbin/mke2fs',
					'/usr/local/opt/e2fsprogs/sbin/mke2fs',
					'debugfs',
					'/opt/homebrew/opt/e2fsprogs/sbin/debugfs',
					'/usr/local/opt/e2fsprogs/sbin/debugfs',
					'cpio',
					'lz4',
					'openclaw',
				] as const,
				path.resolve(
					path.dirname(options.systemConfig.systemConfigPath),
					'..',
					'node_modules',
					'.bin',
				),
			);
			const requiredZigVersion = await options.dependencies.resolveGondolinMinimumZigVersion();
			const zigVersion = await collectCommandOutput('zig', ['version']);
			const dockerDaemonReady = await collectDockerDaemonReady(availableBinaries);
			const doctorResult = options.dependencies.runControllerDoctor({
				availableBinaries,
				dockerDaemonReady,
				env: process.env,
				nodeVersion: process.version,
				requiredZigVersion,
				systemConfig: options.systemConfig,
				...(zigVersion ? { zigVersion } : {}),
			});
			const workerGatewayConfigChecks = await collectWorkerGatewayConfigChecks(
				options.systemConfig,
			);
			const openClawConfigChecks = availableBinaries.has('openclaw')
				? convertConfigValidationChecksToDoctorChecks(
						await collectOpenClawConfigChecks(options.systemConfig),
					)
				: [];
			const openClawDeploymentChecks = await collectOpenClawDeploymentDoctorChecks(
				options.systemConfig,
			);
			const hasZoneGitConfig = options.systemConfig.zones.some(isOpenClawZoneGitConfigured);
			const controllerGithubToken = hasZoneGitConfig
				? await resolveControllerGithubToken(
						options.systemConfig,
						await createResolverFromSystemConfig(options.systemConfig, options.dependencies),
					)
				: null;
			const zoneGitChecks = await collectZoneGitDoctorChecks({
				githubToken: controllerGithubToken,
				systemConfig: options.systemConfig,
			});
			const imageProfileDockerfileChecks = await collectImageProfileDockerfileChecks(
				options.systemConfig,
				availableBinaries.has('docker') && dockerDaemonReady,
			);
			const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(options.systemConfig);
			const dynamicChecks = [
				...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
				...imageProfileDockerfileChecks,
				...workerGatewayConfigChecks,
				...openClawConfigChecks,
				...openClawDeploymentChecks,
				...zoneGitChecks,
			] as const satisfies readonly DoctorCheck[];
			const checks = [...doctorResult.checks, ...dynamicChecks];
			const failed = checks.filter((check) => !check.ok).length;
			const passed = checks.length - failed;
			const result = {
				ok: doctorResult.ok && failed === 0,
				summary: failed === 0 ? 'all checks passed' : `${failed} check(s) failed`,
				passed,
				failed,
				checks,
			} satisfies DoctorCommandResult;
			if (options.restArguments.includes('--json')) {
				writeJson(options.io, result);
				return;
			}
			writeDoctorText(options.io, result, {
				showPassed: options.restArguments.includes('--show-passed'),
			});
			return;
		}
		case 'status':
			writeJson(options.io, await controllerClient.getControllerStatus());
			return;
		case 'stop':
			writeJson(options.io, await controllerClient.stopController());
			return;
		case 'destroy': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(
				options.io,
				await controllerClient.destroyZone(zoneId, options.restArguments.includes('--purge')),
			);
			return;
		}
		case 'upgrade': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(options.io, await controllerClient.upgradeZone(zoneId));
			return;
		}
		case 'logs': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(options.io, await controllerClient.getZoneLogs(zoneId));
			return;
		}
		case 'credentials': {
			if (options.restArguments[0] !== 'refresh') {
				throw new Error(
					`Unknown controller credentials subcommand '${options.restArguments[0] ?? 'undefined'}'.`,
				);
			}

			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			const secretResolver = await createResolverFromSystemConfig(
				options.systemConfig,
				options.dependencies,
			);
			await resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				systemConfig: options.systemConfig,
				zoneId,
			});
			writeJson(options.io, await controllerClient.refreshZoneCredentials(zoneId));
			return;
		}
	}
}
