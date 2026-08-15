import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import { redactOnePasswordReferences } from '@agent-vm/secret-management';
import { dim, green, red } from 'ansis';
import { execa } from 'execa';

import {
	resolveManagedImageRelease,
	type ManagedImageSource,
} from '../build/managed-image-dockerfile.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import {
	collectOpenClawConfigChecks,
	type ConfigValidationCheck,
	resolveProjectCheckoutPath,
} from '../operations/config-validation.js';
import {
	collectManagedImagePackageOverrideDoctorChecks,
	collectVmHostSystemDoctorCheck,
	type DoctorCheck,
} from '../operations/doctor.js';
import { collectOpenClawDeploymentDoctorChecks } from '../operations/openclaw-deployment-doctor.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	requireZone,
	resolveControllerBaseUrl,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunControllerOperationCommandOptions {
	readonly collectDoctorEnvironment?: (
		systemConfig: LoadedSystemConfig,
		dependencies: CliDependencies,
	) => Promise<ControllerDoctorEnvironment>;
	readonly collectDynamicDoctorChecks?: (
		options: CollectDynamicDoctorChecksOptions,
	) => Promise<readonly DoctorCheck[]>;
	readonly dependencies: CliDependencies;
	readonly credentialsAction?: 'check' | 'refresh';
	readonly io: CliIo;
	readonly json?: boolean;
	readonly purge?: boolean;
	readonly showPassed?: boolean;
	readonly subcommand:
		| 'credentials'
		| 'destroy'
		| 'doctor'
		| 'health'
		| 'health-snapshot'
		| 'logs'
		| 'service-health'
		| 'status'
		| 'stop'
		| 'upgrade';
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId?: string;
}

interface ImageProfileDoctorTarget {
	readonly buildConfig: string;
	readonly buildConfigCheckName: string;
	readonly checkName: string;
	readonly dockerfile?: string;
	readonly source?: ManagedImageSource;
	readonly type: 'hermes' | 'openclaw' | 'toolVm' | 'worker';
}

interface DoctorCommandResult {
	readonly checks: readonly DoctorCheck[];
	readonly failed: number;
	readonly ok: boolean;
	readonly passed: number;
	readonly summary: string;
}

export interface ControllerDoctorEnvironment {
	readonly availableBinaries: ReadonlySet<string>;
	readonly dockerDaemonReady: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly nodeVersion: string;
	readonly requiredZigVersion: string;
	readonly zigVersion?: string;
}

export interface CollectDynamicDoctorChecksOptions {
	readonly availableBinaries: ReadonlySet<string>;
	readonly dependencies: CliDependencies;
	readonly dockerDaemonReady: boolean;
	readonly systemConfig: LoadedSystemConfig;
}

const defaultPassingPreviewLimit = 3;
const secretTokenPattern = /(OP_SERVICE_ACCOUNT_TOKEN=)[^\s;]+/gu;
const bearerTokenPattern = /\b(Bearer\s+)[^\s;,'")]+/giu;

function redactDoctorErrorMessage(
	message: string,
	literalSecretValues: readonly string[] = [],
): string {
	let redactedMessage = redactOnePasswordReferences(message)
		.replaceAll(secretTokenPattern, '$1<redacted>')
		.replaceAll(bearerTokenPattern, '$1<redacted>');
	for (const literalSecretValue of literalSecretValues) {
		if (literalSecretValue.length === 0) {
			continue;
		}
		redactedMessage = redactedMessage.replaceAll(literalSecretValue, '<redacted>');
	}
	return redactedMessage;
}

function formatDoctorSafeError(error: unknown): string {
	return redactDoctorErrorMessage(error instanceof Error ? error.message : String(error));
}

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

async function collectOnePasswordHeadlessDoctorChecks(options: {
	readonly availableBinaries: ReadonlySet<string>;
	readonly dependencies: CliDependencies;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<readonly DoctorCheck[]> {
	const tokenSource = options.systemConfig.host.secretsProvider?.tokenSource;
	if (tokenSource === undefined) {
		return [];
	}
	if (!options.availableBinaries.has('op')) {
		return [
			{
				name: '1password-op-cli-headless',
				ok: false,
				hint: 'Install 1Password CLI so SDK fallback can run headlessly: brew install 1password-cli',
			},
		];
	}

	let serviceAccountToken: string;
	try {
		serviceAccountToken = await options.dependencies.resolveServiceAccountToken(tokenSource);
	} catch (error) {
		return [
			{
				name: '1password-service-account-token-resolution',
				ok: false,
				hint: `Configured 1Password service-account token did not resolve: ${formatDoctorSafeError(error)}`,
			},
		];
	}

	const probe = await options.dependencies.probeOnePasswordServiceAccountHeadlessAuth({
		serviceAccountToken,
	});
	return [
		{
			name: '1password-op-cli-headless',
			ok: probe.ok,
			hint: redactDoctorErrorMessage(probe.hint, [serviceAccountToken]),
		},
	];
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

export async function collectControllerDoctorEnvironment(
	systemConfig: LoadedSystemConfig,
	dependencies: CliDependencies,
): Promise<ControllerDoctorEnvironment> {
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
		path.resolve(path.dirname(systemConfig.systemConfigPath), '..', 'node_modules', '.bin'),
	);
	const requiredZigVersion = await dependencies.resolveManagedVmMinimumZigVersion();
	const zigVersion = await collectCommandOutput('zig', ['version']);
	const dockerDaemonReady = await collectDockerDaemonReady(availableBinaries);
	return {
		availableBinaries,
		dockerDaemonReady,
		env: process.env,
		nodeVersion: process.version,
		requiredZigVersion,
		...(zigVersion ? { zigVersion } : {}),
	};
}

export async function collectDynamicDoctorChecks(
	options: CollectDynamicDoctorChecksOptions,
): Promise<readonly DoctorCheck[]> {
	const workerGatewayConfigChecks = await collectWorkerGatewayConfigChecks(options.systemConfig);
	const openClawConfigChecks = options.availableBinaries.has('openclaw')
		? convertConfigValidationChecksToDoctorChecks(
				await collectOpenClawConfigChecks(options.systemConfig),
			)
		: [];
	const openClawDeploymentChecks = await collectOpenClawDeploymentDoctorChecks(
		options.systemConfig,
	);
	const onePasswordHeadlessChecks = await collectOnePasswordHeadlessDoctorChecks({
		availableBinaries: options.availableBinaries,
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
	});
	const imageProfileDockerfileChecks = await collectImageProfileDockerfileChecks(
		options.systemConfig,
		options.availableBinaries.has('docker') && options.dockerDaemonReady,
	);
	const managedImagePackageOverrideChecks = await collectManagedImagePackageOverrideDoctorChecks({
		managedImageRelease: await resolveManagedImageRelease(),
		systemConfig: options.systemConfig,
	});
	const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(options.systemConfig);
	return [
		...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
		...imageProfileDockerfileChecks,
		...managedImagePackageOverrideChecks,
		...workerGatewayConfigChecks,
		...openClawConfigChecks,
		...openClawDeploymentChecks,
		...onePasswordHeadlessChecks,
	] as const;
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

function formatDoctorPassingCheckStatus(): string {
	return dim('ok');
}

function formatDoctorFailedCheckDetails(check: DoctorCheck): readonly string[] {
	const details: string[] = [];
	if (check.value !== undefined) {
		details.push(`      ${String(check.value)}`);
	}
	if (check.hint !== undefined) {
		const [firstLine, ...remainingLines] = check.hint.split('\n');
		details.push(`      ${firstLine ?? ''}`);
		for (const line of remainingLines) {
			details.push(`      ${line}`);
		}
	}
	return details;
}

function appendDoctorFailedCheckLines(lines: string[], checks: readonly DoctorCheck[]): void {
	for (const check of checks) {
		lines.push(`${formatDoctorCheckStatus(check)}  ${check.name}`);
		lines.push(...formatDoctorFailedCheckDetails(check));
	}
}

function formatDoctorPassingCheckDetails(check: DoctorCheck): readonly string[] {
	const details: string[] = [];
	if (check.value !== undefined) {
		details.push(dim(`      ${String(check.value)}`));
	}
	if (check.hint !== undefined) {
		const [firstLine, ...remainingLines] = check.hint.split('\n');
		details.push(dim(`      ${firstLine ?? ''}`));
		for (const line of remainingLines) {
			details.push(dim(`      ${line}`));
		}
	}
	return details;
}

function appendDoctorPassingCheckLines(
	lines: string[],
	checks: readonly DoctorCheck[],
	options: { readonly showDetails: boolean },
): void {
	for (const check of checks) {
		lines.push(`${formatDoctorPassingCheckStatus()}    ${check.name}`);
		if (options.showDetails) {
			lines.push(...formatDoctorPassingCheckDetails(check));
		}
	}
}

function appendDoctorPassingPreviewLines(lines: string[], checks: readonly DoctorCheck[]): void {
	const visibleChecks = checks.slice(0, defaultPassingPreviewLimit);
	appendDoctorPassingCheckLines(lines, visibleChecks, { showDetails: false });
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
		lines.push(red(`Failures (${failedChecks.length})`));
		appendDoctorFailedCheckLines(lines, failedChecks);
	}
	if (options.showPassed && passedChecks.length > 0) {
		if (failedChecks.length > 0) {
			lines.push('');
		}
		lines.push(green(`Passing (${passedChecks.length})`));
		appendDoctorPassingCheckLines(lines, passedChecks, { showDetails: true });
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
			const doctorEnvironment = await (
				options.collectDoctorEnvironment ?? collectControllerDoctorEnvironment
			)(options.systemConfig, options.dependencies);
			const doctorResult = await options.dependencies.runControllerDoctor({
				availableBinaries: doctorEnvironment.availableBinaries,
				dockerDaemonReady: doctorEnvironment.dockerDaemonReady,
				env: doctorEnvironment.env,
				nodeVersion: doctorEnvironment.nodeVersion,
				requiredZigVersion: doctorEnvironment.requiredZigVersion,
				systemConfig: options.systemConfig,
				...(doctorEnvironment.zigVersion ? { zigVersion: doctorEnvironment.zigVersion } : {}),
			});
			const dynamicChecks = await (
				options.collectDynamicDoctorChecks ?? collectDynamicDoctorChecks
			)({
				availableBinaries: doctorEnvironment.availableBinaries,
				dependencies: options.dependencies,
				dockerDaemonReady: doctorEnvironment.dockerDaemonReady,
				systemConfig: options.systemConfig,
			});
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
			if (options.json === true) {
				writeJson(options.io, result);
				return;
			}
			writeDoctorText(options.io, result, {
				showPassed: options.showPassed === true,
			});
			return;
		}
		case 'status':
			writeJson(options.io, await controllerClient.getControllerStatus());
			return;
		case 'health': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			if (!controllerClient.getZoneHealth) {
				throw new Error('Controller client does not support zone health.');
			}
			writeJson(options.io, await controllerClient.getZoneHealth(zoneId));
			return;
		}
		case 'health-snapshot': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			if (!controllerClient.getZoneHealthSnapshot) {
				throw new Error('Controller client does not support zone health snapshots.');
			}
			writeJson(options.io, await controllerClient.getZoneHealthSnapshot(zoneId));
			return;
		}
		case 'service-health': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			if (!controllerClient.getZoneServiceHealth) {
				throw new Error('Controller client does not support zone service health.');
			}
			writeJson(options.io, await controllerClient.getZoneServiceHealth(zoneId));
			return;
		}
		case 'stop':
			writeJson(options.io, await controllerClient.stopController());
			return;
		case 'destroy': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			writeJson(options.io, await controllerClient.destroyZone(zoneId, options.purge === true));
			return;
		}
		case 'upgrade': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			writeJson(options.io, await controllerClient.upgradeZone(zoneId));
			return;
		}
		case 'logs': {
			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			writeJson(options.io, await controllerClient.getZoneLogs(zoneId));
			return;
		}
		case 'credentials': {
			const credentialsSubcommand = options.credentialsAction;
			if (credentialsSubcommand !== 'refresh' && credentialsSubcommand !== 'check') {
				throw new Error('Controller credentials action was not initialized.');
			}

			const zoneId = requireZone(options.systemConfig, options.zoneId).id;
			const secretResolver = await createResolverFromSystemConfig(
				options.systemConfig,
				options.dependencies,
			);
			const resolvedSecrets = await resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				systemConfig: options.systemConfig,
				zoneId,
			});
			if (credentialsSubcommand === 'check') {
				writeJson(options.io, {
					ok: true,
					audience: 'gateway',
					resolvedSecretCount: Object.keys(resolvedSecrets).length,
					zoneId,
				});
				return;
			}
			writeJson(options.io, await controllerClient.refreshZoneCredentials(zoneId));
			return;
		}
	}
}
