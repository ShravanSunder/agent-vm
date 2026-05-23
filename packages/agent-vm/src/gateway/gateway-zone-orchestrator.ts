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

import { assertOpenClawToolVmRequirements } from '../operations/openclaw-deployment-requirements.js';
import { runTaskWithResult } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import { runGatewayHealthCheck } from './gateway-health-check.js';
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
import { writeMcpPortalEffectiveConfig } from './mcp-portal-effective-config.js';

const defaultGatewayReadinessRetryDelayMs = 500;
const defaultGatewayReadinessTimeoutMs = 60_000;
const defaultGatewayReadinessMaxAttempts = Math.ceil(
	defaultGatewayReadinessTimeoutMs / defaultGatewayReadinessRetryDelayMs,
);

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

function formatGatewayCommandFailure(stepName: string, result: GatewayCommandResult): string {
	return `${stepName} failed with exit ${result.exitCode}.${formatCommandOutput('stdout', result.stdout)}${formatCommandOutput('stderr', result.stderr)}`;
}

async function execGatewayCommand(options: {
	readonly command: string;
	readonly managedVm: ManagedVm;
	readonly stepName: string;
}): Promise<GatewayCommandResult> {
	const result = await options.managedVm.exec(options.command);
	if (result.exitCode !== 0) {
		throw new Error(formatGatewayCommandFailure(options.stepName, result));
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

function formatElapsedSeconds(startedAtMs: number): string {
	return ((Date.now() - startedAtMs) / 1000).toFixed(1);
}

async function waitForHealth(options: {
	readonly attempt?: number;
	readonly healthCheck: GatewayHealthCheck;
	readonly lastObservation?: string;
	readonly logPath: string;
	readonly managedVm: ManagedVm;
	readonly maxAttempts?: number;
	readonly retryDelayMs?: number;
	readonly startedAtMs?: number;
}): Promise<void> {
	const attempt = options.attempt ?? 0;
	const retryDelayMs = options.retryDelayMs ?? defaultGatewayReadinessRetryDelayMs;
	const maxAttempts = options.maxAttempts ?? defaultGatewayReadinessMaxAttempts;
	const startedAtMs = options.startedAtMs ?? Date.now();
	const lastObservation = options.lastObservation ?? 'none';
	if (attempt >= maxAttempts) {
		const logTail = await readGatewayLogTail({
			logPath: options.logPath,
			managedVm: options.managedVm,
		});
		throw new Error(
			`Gateway readiness check failed after ${maxAttempts} attempts over ${formatElapsedSeconds(startedAtMs)}s. Last probe: ${lastObservation}. Gateway process may still be booting, or it may have crashed before opening its health port.${logTail ? `\nGateway log tail (${options.logPath}):\n${logTail}` : ''}`,
		);
	}

	const result = await runGatewayHealthCheck({
		exec: async (command) => await options.managedVm.exec(command),
		healthCheck: options.healthCheck,
	});
	if (result.ok) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	await waitForHealth({
		attempt: attempt + 1,
		healthCheck: options.healthCheck,
		lastObservation: result.observation,
		logPath: options.logPath,
		managedVm: options.managedVm,
		maxAttempts,
		retryDelayMs,
		startedAtMs,
	});
}

async function buildRuntimeMcpPortalMaterialization(props: {
	readonly cacheDir: string;
	readonly secretResolver: StartGatewayZoneOptions['secretResolver'];
	readonly zone: GatewayZone;
}): Promise<
	Partial<
		Pick<
			GatewayZoneConfig,
			'egressHosts' | 'runtimeEnvironment' | 'runtimeMediatedSecrets' | 'runtimePluginConfigs'
		>
	>
> {
	const zone = props.zone;
	if (zone.gateway.type !== 'openclaw' || zone.mcpPortal === undefined) {
		return {};
	}
	const allowedRawEnvSecretNames = [
		'OPENCLAW_GATEWAY_TOKEN',
		...(zone.gateway.rawEnvSecrets ?? []),
	];
	const effectiveHostConfigDir = path.join(
		props.cacheDir,
		'gateways',
		zone.id,
		'mcp-portal-effective',
	);
	const effectiveVmConfigDir = '/home/openclaw/.openclaw/cache/mcp-portal-effective';
	const materialization = await writeMcpPortalEffectiveConfig({
		authoredConfigDir: zone.mcpPortal.configDir,
		effectiveHostConfigDir,
		effectiveVmConfigDir,
		allowedRawEnvSecretNames,
		secretResolver: props.secretResolver,
		zoneId: zone.id,
	});
	const declaredGatewayHosts = new Set(
		zone.egressHosts
			.filter((entry) => entry.audience === 'gateway' || entry.audience === 'both')
			.map((entry) => entry.host),
	);
	const generatedGatewayEgressHosts = materialization.requiredGatewayEgressHosts
		.filter((host) => !declaredGatewayHosts.has(host))
		.map((host) => ({ audience: 'gateway' as const, host }));
	return {
		egressHosts: [...zone.egressHosts, ...generatedGatewayEgressHosts],
		runtimeEnvironment: materialization.runtimeEnvironment,
		runtimeMediatedSecrets: materialization.runtimeMediatedSecrets,
		runtimePluginConfigs: {
			'mcp-portal': materialization.pluginConfig,
		},
	};
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone);
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);

	// Phase A: collect host-side prerequisites in parallel.
	//
	// cleanup, assertions, and buildImage operate on disjoint paths (stateDir
	// runtime record, zone.gateway.config file, cacheDir/gateway-images) and
	// have no shared in-process state, so they run concurrently.
	//
	// mcpPortalMat and resolveZoneSecrets both call secretResolver.resolveAll
	// with different ref sets. The 1Password resolver's op-CLI fallback
	// serializes `op read` internally with the comment "Sequential resolution
	// avoids concurrent `op read` failures with the same service account
	// token." Running the two resolveAll calls in parallel would defeat that
	// within-call serialization if both fall back to the op-CLI path. So we
	// chain them: mcpPortalMat → resolveSecrets, as one parallel branch
	// alongside cleanup, assertions, and buildImage.
	const portalAndSecretsPromise = (async () => {
		const mcp = await buildRuntimeMcpPortalMaterialization({
			cacheDir: options.systemConfig.cacheDir,
			secretResolver: options.secretResolver,
			zone,
		});
		const secrets = await runTaskWithResult(
			runTaskStep,
			'Resolving zone secrets',
			async () =>
				await resolveZoneSecrets({
					audience: 'gateway',
					systemConfig: options.systemConfig,
					zoneId: zone.id,
					secretResolver: options.secretResolver,
				}),
		);
		return { mcp, secrets } as const;
	})();
	const cleanupPromise = runTaskStep('Cleaning orphaned gateway runtime', async () => {
		await (dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent)({
			legacyRecordDefaults: {
				configPath: options.systemConfig.systemConfigPath,
				controllerPort: options.systemConfig.host.controllerPort,
			},
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
	});
	const assertionsPromise =
		zone.gateway.type === 'openclaw'
			? runTaskStep('Validating OpenClaw Tool VM requirements', async () => {
					await assertOpenClawToolVmRequirements(options.systemConfig, zone.id);
				})
			: Promise.resolve();
	const imagePromise = runTaskWithResult(runTaskStep, 'Building gateway image', async () => {
		const gatewayImageProfile = selectGatewayImageProfile({
			systemConfig: options.systemConfig,
			zone,
		});
		return await buildGatewayImage(
			{
				buildConfigPath: gatewayImageProfile.buildConfig,
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
	const [{ mcp: mcpPortalMaterialization, secrets: resolvedSecrets }, , , image] =
		await Promise.all([portalAndSecretsPromise, cleanupPromise, assertionsPromise, imagePromise]);
	const lifecycleZone = {
		...mappedLifecycleZone,
		...mcpPortalMaterialization,
		egressHosts: mcpPortalMaterialization.egressHosts ?? mappedLifecycleZone.egressHosts,
		...(options.runtimeEnvironment === undefined
			? {}
			: {
					runtimeEnvironment: {
						...mcpPortalMaterialization.runtimeEnvironment,
						...options.runtimeEnvironment,
					},
				}),
		...(options.runtimePluginConfigs === undefined
			? {}
			: {
					runtimePluginConfigs: {
						...mcpPortalMaterialization.runtimePluginConfigs,
						...options.runtimePluginConfigs,
					},
				}),
	};
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	if (zone.gateway.type === 'openclaw') {
		await fs.mkdir(zone.gateway.zoneFilesDir, { recursive: true });
	}
	const gatewayCacheDir = path.join(options.systemConfig.cacheDir, 'gateways', zone.id);
	await fs.mkdir(gatewayCacheDir, { recursive: true });
	if (zone.gateway.type === 'openclaw') {
		const logDir = path.join(options.systemConfig.runtimeDir, 'zones', zone.id, 'logs');
		await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
		await fs.chmod(logDir, 0o700);
	}
	const vmSpec = lifecycle.buildVmSpec({
		controllerPort: options.systemConfig.host.controllerPort,
		gatewayCacheDir,
		projectNamespace: options.systemConfig.host.projectNamespace,
		resolvedSecrets,
		runtimeDir: options.systemConfig.runtimeDir,
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
	// Phase C: prepareHostState writes to stateDir (realfs-mounted live in
	// the VM), which is only read by the bootstrap exec running INSIDE the
	// VM — that runs after createManagedVm resolves. So the host-side
	// writes can overlap with QEMU boot. Promise.allSettled lets us close
	// an orphan VM if prep fails after the VM came up.
	const prepHostStatePromise = runTaskStep('Preparing host state', async () => {
		await lifecycle.prepareHostState?.(lifecycleZone, options.secretResolver);
	});
	const managedVmPromise = runTaskWithResult(
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
				...(vmSpec.runtimeRootfsSize ? { runtimeRootfsSize: vmSpec.runtimeRootfsSize } : {}),
				secrets: vmSpec.mediatedSecrets,
				sessionLabel: vmSpec.sessionLabel,
				tcpHosts,
				vfsMounts,
			}),
	);
	const [prepHostStateResult, managedVmResult] = await Promise.allSettled([
		prepHostStatePromise,
		managedVmPromise,
	]);
	const phaseCErrors: Error[] = [];
	if (prepHostStateResult.status === 'rejected') {
		phaseCErrors.push(
			prepHostStateResult.reason instanceof Error
				? prepHostStateResult.reason
				: new Error(String(prepHostStateResult.reason)),
		);
		if (managedVmResult.status === 'fulfilled') {
			try {
				await managedVmResult.value.close();
			} catch (closeError) {
				phaseCErrors.push(
					new Error(
						`Failed to close gateway VM after host-state prep failure: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
						{ cause: closeError },
					),
				);
			}
		}
	}
	if (managedVmResult.status === 'rejected') {
		phaseCErrors.push(
			managedVmResult.reason instanceof Error
				? managedVmResult.reason
				: new Error(String(managedVmResult.reason)),
		);
	}
	if (phaseCErrors.length > 1) {
		throw new AggregateError(phaseCErrors, 'Phase C failed: prep host state and/or VM boot');
	}
	if (phaseCErrors.length === 1) {
		throw phaseCErrors[0];
	}
	if (managedVmResult.status !== 'fulfilled') {
		throw new Error('Gateway VM was not created and no error was reported.');
	}
	const managedVm = managedVmResult.value;
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
					controllerPort: options.systemConfig.host.controllerPort,
					gatewayType: zone.gateway.type,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					systemConfigPath: options.systemConfig.systemConfigPath,
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
