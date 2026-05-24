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

import { cleanupOrphanedToolVmsIfPresent } from '../controller/leases/tool-vm-recovery.js';
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
	readonly cleanupOrphanedToolVmsIfPresent?: typeof cleanupOrphanedToolVmsIfPresent;
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly gatewayReadinessMaxAttempts?: number;
	readonly gatewayReadinessRetryDelayMs?: number;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	// Injected by tests so the gateway record build doesn't shell out to ps
	// against a fake pid. Production omits this; uses the real default.
	readonly readProcessIdentity?: (
		pid: number,
	) => Promise<{ readonly command: string; readonly lstart: string } | null>;
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

function toPhaseCError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
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
	// All five branches operate on disjoint paths and have no shared in-process
	// state:
	//   - mcpPortalMaterialization writes $cacheDir/gateways/$zoneId/mcp-portal-effective/
	//   - recovery cleanup reads/deletes $stateDir/tool-leases/*.json and
	//     $stateDir/gateway-runtime.json after ownership checks; tool VM
	//     children are cleaned before the gateway so the old gateway cannot
	//     continue issuing work while child recovery runs.
	//   - assertions reads $zone.gateway.config (pure validation)
	//   - resolveZoneSecrets reads zone.secrets (no IO beyond secretResolver)
	//   - buildGatewayImage operates on $cacheDir/gateway-images/$profile
	//
	// mcpPortalMaterialization and resolveZoneSecrets both call
	// secretResolver.resolveAll concurrently with disjoint ref sets. The
	// @1password/sdk JS client is documented in its source to be concurrency-
	// safe on a single Client instance (SharedCore WASM module handles
	// concurrent invocations). The op-CLI fallback layer is intentionally
	// two-tier only — SDK → op inject — with no further serial `op read`
	// tier; see packages/secret-management/src/onepassword-secret-resolver.ts
	// for the rationale (the previous third tier reintroduced a documented
	// concurrent `op read` hazard at the outer-call layer).
	const mcpPortalMaterializationPromise = buildRuntimeMcpPortalMaterialization({
		cacheDir: options.systemConfig.cacheDir,
		secretResolver: options.secretResolver,
		zone,
	});
	const cleanupOrphanedGateway = async (): Promise<void> => {
		await (dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent)({
			expectedConfigPath: options.systemConfig.systemConfigPath,
			expectedControllerPort: options.systemConfig.host.controllerPort,
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
	};
	// Tool VM orphan cleanup runs in-process-recovery mode only for OpenClaw
	// zones — worker zones never spawn tool VMs, so there is no
	// $stateDir/tool-leases/ subtree to scan. Same five-fence + ps-command
	// discipline as the gateway cleanup above: any scope mismatch skips the
	// record instead of signaling its PID.
	const cleanupOrphanedToolVms = async (): Promise<void> => {
		if (zone.gateway.type !== 'openclaw') {
			return;
		}
		await (dependencies.cleanupOrphanedToolVmsIfPresent ?? cleanupOrphanedToolVmsIfPresent)({
			expectedConfigPath: options.systemConfig.systemConfigPath,
			expectedControllerPort: options.systemConfig.host.controllerPort,
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			tcpBasePort: options.systemConfig.tcpPool.basePort,
			zoneId: zone.id,
		});
	};
	const recoveryCleanupPromise =
		zone.gateway.type === 'openclaw'
			? runTaskStep('Cleaning orphaned tool VMs', async () => {
					await cleanupOrphanedToolVms();
					await runTaskStep('Cleaning orphaned gateway runtime', cleanupOrphanedGateway);
				})
			: runTaskStep('Cleaning orphaned gateway runtime', cleanupOrphanedGateway);
	const assertionsPromise =
		zone.gateway.type === 'openclaw'
			? runTaskStep('Validating OpenClaw Tool VM requirements', async () => {
					await assertOpenClawToolVmRequirements(options.systemConfig, zone.id);
				})
			: Promise.resolve();
	const resolvedSecretsPromise = runTaskWithResult(
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
	// Promise.all (fail-fast) rather than Promise.allSettled here. Rationale:
	//   - The image build branch can be slow on a cold cache (minutes for a
	//     full Gondolin rebuild). If any other branch fails fast (e.g., a
	//     config assertion at ~10ms), we want the operator to see the error
	//     immediately, not after the image build completes.
	//   - The realistic multi-failure mode (1Password is down) hits both
	//     secretResolver.resolveAll callers with the same root cause at the
	//     same op-CLI timeout (~30s). Promise.all surfaces the first; that's
	//     diagnostically sufficient.
	//   - Phase C uses allSettled for a DIFFERENT reason: it has a live
	//     QEMU resource to close on partial failure. Phase A produces no
	//     such resource.
	//
	// Cost of fail-fast: if multiple branches reject simultaneously, the
	// other reasons are lost (only the first reaches the caller). Background
	// completion of the other branches is harmless — no Phase A branch
	// produces a host-visible resource that needs cleanup.
	const [mcpPortalMaterialization, , , resolvedSecrets, image] = await Promise.all([
		mcpPortalMaterializationPromise,
		recoveryCleanupPromise,
		assertionsPromise,
		resolvedSecretsPromise,
		imagePromise,
	]);
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
	// Aggregate any failures from either Phase C branch. If prep failed
	// after the VM came up, close the VM before throwing. The outer guard
	// handles all failure paths in one place so the happy path below can
	// rely on TypeScript narrowing both settled results to `fulfilled`
	// without a dead-code assertion.
	if (prepHostStateResult.status === 'rejected' || managedVmResult.status === 'rejected') {
		const phaseCErrors: Error[] = [];
		if (prepHostStateResult.status === 'rejected') {
			phaseCErrors.push(toPhaseCError(prepHostStateResult.reason));
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
			phaseCErrors.push(toPhaseCError(managedVmResult.reason));
		}
		if (phaseCErrors.length > 1) {
			throw new AggregateError(phaseCErrors, 'Phase C failed: prep host state and/or VM boot');
		}
		// At least one branch rejected, so phaseCErrors has exactly one entry.
		const [singlePhaseCError] = phaseCErrors;
		if (singlePhaseCError === undefined) {
			throw new Error('Phase C unreachable: rejection branch with no collected errors');
		}
		throw singlePhaseCError;
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
			bufferResponseBody: false,
			listenPort: zone.gateway.port,
			...(zone.gateway.ingress?.upstreamHeaderTimeoutMs === undefined
				? {}
				: { upstreamHeaderTimeoutMs: zone.gateway.ingress.upstreamHeaderTimeoutMs }),
			...(zone.gateway.ingress?.upstreamResponseTimeoutMs === undefined
				? {}
				: { upstreamResponseTimeoutMs: zone.gateway.ingress.upstreamResponseTimeoutMs }),
		});
		await runTaskStep('Recording gateway runtime', async () => {
			await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
				zone.gateway.stateDir,
				await buildGatewayRuntimeRecord({
					controllerPort: options.systemConfig.host.controllerPort,
					gatewayType: zone.gateway.type,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					...(dependencies.readProcessIdentity !== undefined
						? { readProcessIdentity: dependencies.readProcessIdentity }
						: {}),
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
