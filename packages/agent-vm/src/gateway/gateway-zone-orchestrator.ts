import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@agent-vm/gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';

import { runTaskWithResult } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import { cleanupOrphanedGatewayIfPresent } from './gateway-recovery.js';
import {
	buildGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
	type GatewayRuntimeRecord,
} from './gateway-runtime-record.js';
import {
	findGatewayZone,
	mapSystemGatewayZoneToLifecycleZone,
	type GatewayZone,
	type GatewayManagedVmFactoryOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly cleanupOrphanedGatewayIfPresent?: typeof cleanupOrphanedGatewayIfPresent;
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly gatewayReadinessMaxAttempts?: number;
	readonly gatewayReadinessRetryDelayMs?: number;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	readonly writeGatewayRuntimeRecord?: (
		stateDirectory: string,
		record: GatewayRuntimeRecord,
	) => Promise<void>;
}

interface GatewayCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

function selectGatewayImageProfile(options: {
	readonly systemConfig: import('../config/system-config.js').SystemConfig;
	readonly zone: GatewayZone;
}): import('../config/system-config.js').SystemConfig['imageProfiles']['gateways'][string] {
	const profile = options.systemConfig.imageProfiles.gateways[options.zone.gateway.imageProfile];
	if (!profile) {
		throw new Error(
			`Gateway image profile '${options.zone.gateway.imageProfile}' is not configured.`,
		);
	}
	return profile;
}

function formatCommandOutput(name: string, value: string): string {
	const trimmedValue = value.trim();
	return trimmedValue.length > 0 ? `\n${name}:\n${trimmedValue}` : '';
}

function formatGatewayCommandFailure(
	stepName: string,
	command: string,
	result: GatewayCommandResult,
): string {
	return `${stepName} failed with exit ${result.exitCode}.${formatCommandOutput('stdout', result.stdout)}${formatCommandOutput('stderr', result.stderr)}\nCommand:\n${command}`;
}

async function execGatewayCommand(options: {
	readonly command: string;
	readonly managedVm: ManagedVm;
	readonly stepName: string;
}): Promise<GatewayCommandResult> {
	const result = await options.managedVm.exec(options.command);
	if (result.exitCode !== 0) {
		throw new Error(formatGatewayCommandFailure(options.stepName, options.command, result));
	}
	return result;
}

async function readGatewayLogTail(options: {
	readonly logPath: string;
	readonly managedVm: ManagedVm;
}): Promise<string | undefined> {
	try {
		const result = await options.managedVm.exec(
			`tail -n 80 ${options.logPath} 2>/dev/null || true`,
		);
		const output = [result.stdout.trim(), result.stderr.trim()]
			.filter((chunk) => chunk.length > 0)
			.join('\n');
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function waitForHealth(options: {
	readonly attempt?: number;
	readonly healthCheck: GatewayHealthCheck;
	readonly lastObservation?: string;
	readonly logPath: string;
	readonly managedVm: ManagedVm;
	readonly maxAttempts?: number;
	readonly retryDelayMs?: number;
}): Promise<void> {
	const attempt = options.attempt ?? 0;
	const maxAttempts = options.maxAttempts ?? 30;
	const retryDelayMs = options.retryDelayMs ?? 500;
	const lastObservation = options.lastObservation ?? 'none';
	if (attempt >= maxAttempts) {
		const logTail = await readGatewayLogTail({
			logPath: options.logPath,
			managedVm: options.managedVm,
		});
		throw new Error(
			`Gateway readiness check failed after ${maxAttempts} attempts. Last observation: ${lastObservation}.${logTail ? `\nGateway log tail (${options.logPath}):\n${logTail}` : ''}`,
		);
	}

	const healthCommand =
		options.healthCheck.type === 'http'
			? `curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${options.healthCheck.port}${options.healthCheck.path} 2>/dev/null || true`
			: options.healthCheck.command;
	const result = await options.managedVm.exec(healthCommand);
	const currentObservation =
		options.healthCheck.type === 'http'
			? `http ${result.stdout.trim() || '(empty)'}`
			: `exit ${result.exitCode}`;
	if (
		(options.healthCheck.type === 'http' && result.stdout.trim().startsWith('2')) ||
		(options.healthCheck.type === 'command' && result.exitCode === 0)
	) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	await waitForHealth({
		attempt: attempt + 1,
		healthCheck: options.healthCheck,
		lastObservation: currentObservation,
		logPath: options.logPath,
		managedVm: options.managedVm,
		maxAttempts,
		retryDelayMs,
	});
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone);
	await runTaskStep('Cleaning orphaned gateway runtime', async () => {
		await (dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent)({
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
	});
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);
	const resolvedSecrets = await runTaskWithResult(
		runTaskStep,
		'Resolving zone secrets',
		async () =>
			await resolveZoneSecrets({
				systemConfig: options.systemConfig,
				zoneId: zone.id,
				secretResolver: options.secretResolver,
			}),
	);
	const image = await runTaskWithResult(runTaskStep, 'Building gateway image', async () => {
		const gatewayImageProfile = selectGatewayImageProfile({
			systemConfig: options.systemConfig,
			zone,
		});
		return await buildGatewayImage(
			{
				buildConfigPath: gatewayImageProfile.buildConfig,
				systemCacheIdentifierPath: options.systemConfig.systemCacheIdentifierPath,
				cacheDir: path.join(
					options.systemConfig.cacheDir,
					'gateway-images',
					zone.gateway.imageProfile,
				),
			},
			{
				...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
				...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
			},
		);
	});
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	await fs.mkdir(zone.gateway.workspaceDir, { recursive: true });
	await runTaskStep('Preparing host state', async () => {
		await lifecycle.prepareHostState?.(lifecycleZone, options.secretResolver);
	});
	const vmSpec = lifecycle.buildVmSpec({
		controllerPort: options.systemConfig.host.controllerPort,
		projectNamespace: options.systemConfig.host.projectNamespace,
		resolvedSecrets,
		tcpPool: options.systemConfig.tcpPool,
		zone: lifecycleZone,
	});
	const processSpec = lifecycle.buildProcessSpec(lifecycleZone, resolvedSecrets);
	const environment = {
		...vmSpec.environment,
		...options.environmentOverride,
	};
	const tcpHosts = {
		...vmSpec.tcpHosts,
		...options.tcpHostsOverride,
	};
	const vfsMounts = {
		...vmSpec.vfsMounts,
		...options.vfsMountsOverride,
	};
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const managedVm = await runTaskWithResult(
		runTaskStep,
		'Booting gateway VM',
		async () =>
			await createManagedVm({
				allowedHosts: vmSpec.allowedHosts,
				cpus: zone.gateway.cpus,
				env: environment,
				imagePath: image.imagePath,
				memory: zone.gateway.memory,
				rootfsMode: vmSpec.rootfsMode,
				secrets: vmSpec.mediatedSecrets,
				sessionLabel: vmSpec.sessionLabel,
				tcpHosts,
				vfsMounts,
			}),
	);
	try {
		await runTaskStep('Configuring gateway', async () => {
			await execGatewayCommand({
				command: processSpec.bootstrapCommand,
				managedVm,
				stepName: 'Configuring gateway',
			});
		});
		await runTaskStep('Starting gateway', async () => {
			await execGatewayCommand({
				command: processSpec.startCommand,
				managedVm,
				stepName: 'Starting gateway',
			});
		});
		await runTaskStep('Waiting for readiness', async () => {
			await waitForHealth({
				healthCheck: processSpec.healthCheck,
				logPath: processSpec.logPath,
				managedVm,
				...(dependencies.gatewayReadinessMaxAttempts !== undefined
					? { maxAttempts: dependencies.gatewayReadinessMaxAttempts }
					: {}),
				...(dependencies.gatewayReadinessRetryDelayMs !== undefined
					? { retryDelayMs: dependencies.gatewayReadinessRetryDelayMs }
					: {}),
			});
		});
		managedVm.setIngressRoutes([
			{
				port: processSpec.guestListenPort,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		const ingress = await managedVm.enableIngress({
			listenPort: zone.gateway.port,
		});
		await runTaskStep('Recording gateway runtime', async () => {
			await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
				zone.gateway.stateDir,
				buildGatewayRuntimeRecord({
					gatewayType: zone.gateway.type,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					zoneId: zone.id,
				}),
			);
		});
		return {
			image,
			ingress,
			processSpec,
			vm: managedVm,
			zone,
		};
	} catch (error) {
		await managedVm.close().catch((closeError: unknown) => {
			process.stderr.write(
				`[agent-vm] Failed to close gateway VM after startup failure: ${closeError instanceof Error ? closeError.message : JSON.stringify(closeError)}\n`,
			);
		});
		throw error;
	}
}
