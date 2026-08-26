/* oxlint-disable eslint/no-await-in-loop -- live readiness uses bounded sequential protocol probes */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { wrapWithHermesShellEnvironment } from '@agent-vm/hermes-gateway';
import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import { zoneSshAccessResponseSchema } from '../cli/ssh-commands.js';
import {
	connectGatewayControlSession,
	GATEWAY_CONTROL_RECONNECT_DEADLINE_MS,
	GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS,
	type GatewayDisposableControlSessionClient,
} from '../controller/control-session/index.js';
import { createControllerClient } from '../controller/http/controller-client.js';
import {
	startControlTransportReliabilityProxy,
	type ControlTransportReliabilityProxy,
} from '../controller/reliability/testing/control-transport-reliability-proxy.js';
import { readManagedGatewaySiblingProcessIdentity } from '../controller/reliability/testing/gateway-reliability-fault-adapter.js';
import type { GatewayExpectedAdmissionCohort } from '../gateway/gateway-aggregate-admission-state.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	startE2eControllerRuntime,
	startE2eGatewayZone,
	startE2eGatewayZoneForController,
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import { startHermesDeterministicToolCallModelServer } from './hermes-deterministic-tool-call-model-server.js';
import {
	buildHermesE2eProfileApiServerKeySecrets,
	hermesE2eProfileApiServerKey,
	hermesE2eProfileApiServerKeyEnvironmentName,
	hermesE2eRootApiServerKey,
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

const architecture = currentE2eArchitecture();
const runHermesManagedEnvironmentE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeHermesManagedEnvironmentE2e = runHermesManagedEnvironmentE2e
	? describe
	: describe.skip;
const runHermesControlReattachmentStress = process.env.AGENT_VM_HERMES_REATTACHMENT_STRESS === '1';
const agentIds = ['main', 'beta'] as const;
const discordSecretEnvironmentNames = {
	beta: 'DISCORD_BOT_TOKEN_BETA_E2E',
	main: 'DISCORD_BOT_TOKEN_MAIN_E2E',
} as const;
const discordSecretCanaries = {
	beta: 'synthetic-beta-discord-profile-canary',
	main: 'synthetic-main-discord-profile-canary',
} as const;
const commonAcceptanceMarkers = {
	first: 'hermes-common-policy-marker-a',
	second: 'hermes-common-policy-marker-b',
} as const;
const nativeProfileMarkers = {
	beta: 'hermes-native-beta-leaf',
	main: 'hermes-native-main-leaf',
	root: 'hermes-native-root-leaf',
} as const;
const fakeModelContextLength = 65_536;
const fakeModelHost = 'hermes-model.provider.test';
const fakeModelName = 'hermes-e2e';
const providerCredentialCanary = 'synthetic-hermes-provider-credential-canary';
const providerCredentialEnvironmentName = 'PROVIDER_API_KEY';
const fakeModelPort = 18_080;
const frameworkGapMarker = 'HERMES_FRAMEWORK_AVAILABLE_DURING_CONTROL_GAP';
const toolVmRecoveryMarker = 'HERMES_TOOL_VM_RECOVERY_OK';
const filesystemMarker = 'HERMES_STOCK_FILESYSTEM_WRITE_READ_OK';
const filesystemIsolationMarker = 'HERMES_FILESYSTEM_PROFILE_ISOLATION_OK';
const execFileAsync = promisify(execFile);

interface ManagedGatewayStartObservation {
	readonly controlSession: GatewayDisposableControlSessionClient;
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly managedVmCreateRequest?: ManagedVmCreateRequest;
	readonly qemuPid: number;
	readonly vm: Pick<GatewayZoneVmOperations, 'exec' | 'getHostProcessId' | 'id'>;
}

interface ManagedHermesEpoch {
	readonly controlTransportProxy?: ControlTransportReliabilityProxy;
	readonly harness: E2eHarnessRuntime;
	readonly start: ManagedGatewayStartObservation;
	readonly toolVmCreateRequests: readonly ManagedVmCreateRequest[];
}

async function expectHermesInteractiveShellEnvironment(
	vm: Pick<GatewayZoneVmOperations, 'exec'>,
): Promise<void> {
	const shellEnvironmentResult = await vm.exec([
		'/bin/sh',
		'-c',
		wrapWithHermesShellEnvironment(
			[
				'test "$HERMES_HOME" = "/home/hermes/.hermes"',
				'test "$HERMES_TUI_DIR" = "/opt/hermes/ui-tui"',
				'test -f "$HERMES_TUI_DIR/dist/entry.js"',
				'test "$SSL_CERT_FILE" = "/run/gondolin/ca-certificates.crt"',
				'test "$REQUESTS_CA_BUNDLE" = "/run/gondolin/ca-certificates.crt"',
				'command -v hermes >/dev/null',
			].join(' && '),
		),
	]);
	expect(shellEnvironmentResult).toMatchObject({
		exitCode: 0,
		ok: true,
	});
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function renderCommonConfiguration(acceptanceMarker: string): string {
	return renderHermesManagedE2eConfiguration({
		acceptanceMarker,
		contextLength: fakeModelContextLength,
		fakeModelBaseUrl: `http://127.0.0.1:${String(fakeModelPort)}/v1`,
		fakeModelHost,
		fakeModelName,
	});
}

interface HermesChatCompletionResponse {
	readonly body: unknown;
	readonly status: number;
}

async function requestHermesChatCompletion(options: {
	readonly apiServerKey: string;
	readonly gatewayPort: number;
	readonly profileName?: (typeof agentIds)[number];
	readonly prompt: string;
}): Promise<HermesChatCompletionResponse> {
	const routePrefix = options.profileName === undefined ? '' : `/p/${options.profileName}`;
	const response = await fetch(
		`http://127.0.0.1:${String(options.gatewayPort)}${routePrefix}/v1/chat/completions`,
		{
			body: JSON.stringify({
				messages: [{ content: options.prompt, role: 'user' }],
				model: fakeModelName,
				stream: false,
			}),
			headers: {
				authorization: `Bearer ${options.apiServerKey}`,
				'content-type': 'application/json',
			},
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
		},
	);
	return { body: (await response.json()) as unknown, status: response.status };
}

async function callHermesProfile(options: {
	readonly apiServerKey: string;
	readonly gatewayPort: number;
	readonly profileName?: (typeof agentIds)[number];
	readonly prompt: string;
}): Promise<string> {
	const response = await requestHermesChatCompletion(options);
	const responseBody = response.body;
	if (
		response.status < 200 ||
		response.status >= 300 ||
		typeof responseBody !== 'object' ||
		responseBody === null ||
		!('choices' in responseBody) ||
		!Array.isArray(responseBody.choices)
	) {
		throw new Error(
			`Hermes profile request failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	const firstChoice: unknown = responseBody.choices[0];
	if (
		typeof firstChoice !== 'object' ||
		firstChoice === null ||
		!('message' in firstChoice) ||
		typeof firstChoice.message !== 'object' ||
		firstChoice.message === null ||
		!('content' in firstChoice.message) ||
		typeof firstChoice.message.content !== 'string'
	) {
		throw new Error(`Hermes profile response was malformed: ${JSON.stringify(responseBody)}`);
	}
	return firstChoice.message.content;
}

async function expectHermesApiKeyRejected(options: {
	readonly apiServerKey: string;
	readonly gatewayPort: number;
	readonly profileName?: (typeof agentIds)[number];
}): Promise<void> {
	const response = await requestHermesChatCompletion({
		...options,
		prompt: 'NO_TOOL_FRAMEWORK_PROBE',
	});
	expect(response).toMatchObject({
		body: {
			error: {
				code: 'gateway_auth_failed',
				message: 'Invalid gateway API key (API_SERVER_KEY)',
			},
		},
		status: 401,
	});
}

async function expectHermesApiKeyIsolation(gatewayPort: number): Promise<void> {
	expect(
		await callHermesProfile({
			apiServerKey: hermesE2eProfileApiServerKey('main'),
			gatewayPort,
			profileName: 'main',
			prompt: 'NO_TOOL_FRAMEWORK_PROBE',
		}),
	).toContain(frameworkGapMarker);
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eProfileApiServerKey('beta'),
		gatewayPort,
		profileName: 'main',
	});
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eRootApiServerKey,
		gatewayPort,
		profileName: 'main',
	});

	expect(
		await callHermesProfile({
			apiServerKey: hermesE2eProfileApiServerKey('beta'),
			gatewayPort,
			profileName: 'beta',
			prompt: 'NO_TOOL_FRAMEWORK_PROBE',
		}),
	).toContain(frameworkGapMarker);
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eProfileApiServerKey('main'),
		gatewayPort,
		profileName: 'beta',
	});
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eRootApiServerKey,
		gatewayPort,
		profileName: 'beta',
	});

	expect(
		await callHermesProfile({
			apiServerKey: hermesE2eRootApiServerKey,
			gatewayPort,
			prompt: 'NO_TOOL_FRAMEWORK_PROBE',
		}),
	).toContain(frameworkGapMarker);
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eProfileApiServerKey('main'),
		gatewayPort,
	});
	await expectHermesApiKeyRejected({
		apiServerKey: hermesE2eProfileApiServerKey('beta'),
		gatewayPort,
	});
}

async function waitForFreshAcceptedControlSession(options: {
	readonly controlSession: GatewayDisposableControlSessionClient;
	readonly minimumAttachmentGeneration: number;
	readonly previousSessionId: string;
}): Promise<void> {
	const deadlineMs = Date.now() + 120_000;
	while (Date.now() < deadlineMs) {
		const diagnostics = options.controlSession.getDiagnostics();
		if (
			diagnostics.connected &&
			diagnostics.ready &&
			diagnostics.attachmentGeneration !== undefined &&
			diagnostics.attachmentGeneration >= options.minimumAttachmentGeneration &&
			diagnostics.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.lastHelloResponse.sessionId !== options.previousSessionId
		) {
			return;
		}
		await waitForProtocolRetryInterval(500);
	}
	throw new Error(
		`Timed out waiting for the recovered Hermes control session: ${JSON.stringify(options.controlSession.getDiagnostics())}`,
	);
}

async function materializeNativeProfileLeaves(project: HermesE2eProject): Promise<void> {
	const nativeConfigurationPaths = {
		beta: path.join(project.zone.gateway.stateDir, 'profiles', 'beta', 'config.yaml'),
		main: path.join(project.zone.gateway.stateDir, 'profiles', 'main', 'config.yaml'),
		root: path.join(project.zone.gateway.stateDir, 'config.yaml'),
	} as const;
	await Promise.all(
		Object.entries(nativeConfigurationPaths).map(async ([profileName, configurationPath]) => {
			await mkdir(path.dirname(configurationPath), { recursive: true });
			const profileMarker = nativeProfileMarkers[profileName as keyof typeof nativeProfileMarkers];
			await writeFile(
				configurationPath,
				profileName === 'root'
					? `agent_vm_profile_marker: ${profileMarker}\n`
					: `agent_vm_profile_marker: ${profileMarker}\nplatforms:\n  api_server:\n    enabled: false\n`,
				'utf8',
			);
		}),
	);
}

async function readNativeProfileLeaves(
	project: HermesE2eProject,
): Promise<Readonly<Record<keyof typeof nativeProfileMarkers, string>>> {
	return {
		beta: await readFile(
			path.join(project.zone.gateway.stateDir, 'profiles', 'beta', 'config.yaml'),
			'utf8',
		),
		main: await readFile(
			path.join(project.zone.gateway.stateDir, 'profiles', 'main', 'config.yaml'),
			'utf8',
		),
		root: await readFile(path.join(project.zone.gateway.stateDir, 'config.yaml'), 'utf8'),
	};
}

function configureHermesSecrets(project: HermesE2eProject): void {
	Object.assign(project.zone.gateway, {
		profileSecretProjectionsByAgent: Object.fromEntries(
			agentIds.map((agentId) => [
				agentId,
				{
					API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName(agentId),
					DISCORD_BOT_TOKEN: discordSecretEnvironmentNames[agentId],
					[providerCredentialEnvironmentName]: providerCredentialEnvironmentName,
				},
			]),
		),
	});
	for (const agentId of agentIds) {
		const secretEnvironmentName = discordSecretEnvironmentNames[agentId];
		project.zone.secrets[secretEnvironmentName] = {
			audience: 'gateway',
			envVar: secretEnvironmentName,
			injection: 'env',
			source: 'environment',
		};
	}
	project.zone.secrets[providerCredentialEnvironmentName] = {
		audience: 'gateway',
		envVar: providerCredentialEnvironmentName,
		hosts: [fakeModelHost],
		injection: 'http-mediation',
		source: 'environment',
	};
	project.zone.egressHosts = [
		...(project.zone.egressHosts ?? []),
		{ audience: 'gateway', host: fakeModelHost },
	];
}

function resolvedHermesSecrets(): Readonly<Record<string, string>> {
	return {
		...buildHermesE2eProfileApiServerKeySecrets(agentIds),
		[discordSecretEnvironmentNames.beta]: discordSecretCanaries.beta,
		[discordSecretEnvironmentNames.main]: discordSecretCanaries.main,
		[providerCredentialEnvironmentName]: providerCredentialCanary,
		GITHUB_TOKEN: 'unused-hermes-managed-environment-token',
	};
}

async function startManagedHermesEpoch(options: {
	readonly enableControlTransportIsolation?: boolean;
	readonly project: HermesE2eProject;
}): Promise<ManagedHermesEpoch> {
	let controlTransportProxy: ControlTransportReliabilityProxy | undefined;
	let managedGatewayStart: ManagedGatewayStartObservation | undefined;
	const toolVmCreateRequests: ManagedVmCreateRequest[] = [];
	let harness: Awaited<ReturnType<typeof startE2eControllerRuntime>>;
	try {
		harness = await startE2eControllerRuntime({
			onControllerManagedVmCreateRequest: (request) => {
				toolVmCreateRequests.push(request);
			},
			secrets: resolvedHermesSecrets(),
			startGatewayZone: async (startOptions) => {
				let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
				const result = options.enableControlTransportIsolation
					? await startE2eGatewayZoneForController(startOptions, {
							connectGatewayControlSession: async (connectOptions) => {
								controlTransportProxy = await startControlTransportReliabilityProxy({
									target: connectOptions.endpoint,
								});
								return await connectGatewayControlSession({
									...connectOptions,
									endpoint: {
										...connectOptions.endpoint,
										...controlTransportProxy.endpoint,
									},
								});
							},
						})
					: await startE2eGatewayZone(startOptions, {
							onManagedVmCreateRequest: (request) => {
								managedVmCreateRequest = request;
							},
						});
				if (result.executionModel !== 'managed-gateway' || result.controlSession === undefined) {
					throw new Error('Hermes managed environment E2E requires a managed Gateway image boot.');
				}
				if (!options.enableControlTransportIsolation && managedVmCreateRequest === undefined) {
					throw new Error('Hermes managed environment E2E did not observe its Gateway VM request.');
				}
				const qemuPid = result.vm.getHostProcessId();
				if (qemuPid === null) {
					throw new Error('Managed Hermes Gateway start omitted its QEMU pid.');
				}
				managedGatewayStart = {
					controlSession: result.controlSession,
					expectedCohort: result.expectedCohort,
					...(managedVmCreateRequest === undefined ? {} : { managedVmCreateRequest }),
					qemuPid,
					vm: result.vm,
				};
				return result;
			},
			startOptions: {
				systemConfig: options.project.systemConfig,
				zoneIds: [options.project.zone.id],
			},
		});
	} catch (error: unknown) {
		await controlTransportProxy?.close().catch(() => undefined);
		throw error;
	}
	if (managedGatewayStart === undefined) {
		try {
			await harness.close({ preserveTempRoot: true });
		} finally {
			await controlTransportProxy?.close();
		}
		throw new Error('Hermes managed environment E2E did not observe the managed Gateway start.');
	}
	return {
		...(controlTransportProxy === undefined ? {} : { controlTransportProxy }),
		harness,
		start: managedGatewayStart,
		toolVmCreateRequests,
	};
}

function assertManagedGatewayProjection(
	start: ManagedGatewayStartObservation,
	project: HermesE2eProject,
): void {
	const request = start.managedVmCreateRequest;
	if (request === undefined) {
		throw new Error('Managed Hermes Gateway projection assertion requires its VM create request.');
	}
	expect(request.environment.HERMES_MANAGED_DIR).toBeUndefined();
	expect(request.environment.HERMES_MANAGED).toBeUndefined();
	expect(request.mounts['/etc/hermes']).toMatchObject({
		access: 'read-only',
		hostPath: path.dirname(project.zone.gateway.config),
		kind: 'host-directory',
	});
	expect(Object.keys(request.environment)).not.toContain(providerCredentialEnvironmentName);
	expect(Object.values(request.environment)).not.toContain(providerCredentialCanary);
	const mediatedProvider = request.mediatedSecrets.find(
		(secret) => secret.environmentVariable === providerCredentialEnvironmentName,
	);
	expect(mediatedProvider).toMatchObject({
		allowedHosts: [fakeModelHost],
		value: providerCredentialCanary,
	});
	expect(mediatedProvider?.guestPlaceholder).toEqual(expect.any(String));
	expect(mediatedProvider?.guestPlaceholder).not.toBe(providerCredentialCanary);
}

async function waitForRootApiHealth(options: {
	readonly gatewayPort: number;
	readonly vm: Pick<GatewayZoneVmOperations, 'exec'>;
}): Promise<void> {
	const deadlineMs = Date.now() + 60_000;
	let lastStatus: number | undefined;
	let lastError: string | undefined;
	while (Date.now() < deadlineMs) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(options.gatewayPort)}/health`, {
				signal: AbortSignal.timeout(2_000),
			});
			lastStatus = response.status;
			if (response.ok) return;
		} catch (error: unknown) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await waitForProtocolRetryInterval(250);
	}
	const serviceLog = await options.vm.exec(
		'tail -n 200 /var/log/agent-vm/hermes-service.log 2>&1 || true',
	);
	throw new Error(
		`Timed out waiting for the Hermes root API: ${JSON.stringify({ lastError, lastStatus, serviceLog })}`,
	);
}

async function inspectLiveHermesEpoch(options: {
	readonly acceptanceMarker: string;
	readonly start: ManagedGatewayStartObservation;
}): Promise<unknown> {
	const frameworkPort = options.start.expectedCohort.ingressIntent.frameworkRootRoute.guestPort;
	const toolPortalPort = options.start.expectedCohort.ingressIntent.controlRoute.guestPort;
	const [frameworkIdentity, toolPortalIdentity] = await Promise.all([
		readManagedGatewaySiblingProcessIdentity({
			gatewayVm: options.start.vm,
			guestPort: frameworkPort,
			role: 'framework',
		}),
		readManagedGatewaySiblingProcessIdentity({
			gatewayVm: options.start.vm,
			guestPort: toolPortalPort,
			role: 'tool-portal',
		}),
	]);
	const result = await options.start.vm.exec(
		[
			'/opt/hermes/.venv/bin/python',
			'-',
			String(frameworkIdentity.processId),
			String(toolPortalIdentity.processId),
			sha256(providerCredentialCanary),
		],
		{
			stdin: `
import hashlib
import json
import os
import sys
from pathlib import Path

from agent_vm_hermes_adapter.managed_gateway_bootstrap import (
    _HermesManagedPolicyReadBindings,
)
from gateway import run as gateway_run
from hermes_cli import managed_scope
from hermes_cli.config import load_config

framework_process_id, tool_portal_process_id, provider_digest = sys.argv[1:]

def process_environment(process_id):
    entries = [
        entry
        for entry in Path(f"/proc/{process_id}/environ").read_bytes().split(b"\\0")
        if entry
    ]
    values = {
        entry.partition(b"=")[0].decode(errors="replace"): entry.partition(b"=")[2]
        for entry in entries
    }
    return {
        "names": set(values),
        "values": values,
        "valueDigests": {
            hashlib.sha256(entry.partition(b"=")[2]).hexdigest()
            for entry in entries
        },
    }

def process_identity(process_id):
    process_stat = Path(f"/proc/{process_id}").stat()
    return {
        "gid": process_stat.st_gid,
        "uid": process_stat.st_uid,
    }

def matching_process_count(command_marker):
    count = 0
    for process_path in Path("/proc").iterdir():
        if not process_path.name.isdigit():
            continue
        try:
            command_line = (process_path / "cmdline").read_bytes()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if command_marker in command_line:
            count += 1
    return count

profile_homes = {
    "root": "/home/hermes/.hermes",
    "main": "/home/hermes/.hermes/profiles/main",
    "beta": "/home/hermes/.hermes/profiles/beta",
}
profile_snapshots = {}
bindings = _HermesManagedPolicyReadBindings()
bindings.install()
try:
    for profile_name, profile_home in profile_homes.items():
        os.environ["HERMES_HOME"] = profile_home
        configuration = load_config()
        model = configuration.get("model", {})
        plugins = configuration.get("plugins", {})
        state_write_probe = Path(profile_home) / ".agent-vm-e2e-write-probe"
        try:
            state_write_probe.write_text("write probe", encoding="utf-8")
        except OSError:
            state_writable = False
        else:
            state_write_probe.unlink(missing_ok=True)
            state_writable = True
        profile_snapshots[profile_name] = {
            "acceptanceMarker": configuration.get("agent_vm_acceptance_marker"),
            "fallbackProviders": gateway_run.get_fallback_chain(configuration),
            "localMarker": configuration.get("agent_vm_profile_marker"),
            "modelDefault": model.get("default"),
            "modelProvider": model.get("provider"),
            "pluginDisabled": plugins.get("disabled"),
            "pluginEnabled": plugins.get("enabled"),
            "providerRouting": gateway_run.GatewayRunner._load_provider_routing(),
            "stateWritable": state_writable,
        }
finally:
    bindings.close()

framework_environment = process_environment(framework_process_id)
tool_portal_environment = process_environment(tool_portal_process_id)
managed_write_probe = Path("/etc/hermes/.agent-vm-e2e-write-probe")
try:
    managed_write_probe.write_text("write probe", encoding="utf-8")
except OSError:
    managed_configuration_read_only = True
else:
    managed_write_probe.unlink(missing_ok=True)
    managed_configuration_read_only = False
print(json.dumps({
    "frameworkContainsRawProviderCredential": (
        provider_digest in framework_environment["valueDigests"]
    ),
    "frameworkEnvironmentHasDiscordToken": (
        "DISCORD_BOT_TOKEN" in framework_environment["names"]
    ),
    "frameworkEnvironmentHasManagedDir": (
        "HERMES_MANAGED_DIR" in framework_environment["names"]
    ),
    "frameworkEnvironmentHasManagedLock": (
        "HERMES_MANAGED" in framework_environment["names"]
    ),
    "frameworkMultiplexEnabled": (
        framework_environment["values"].get("GATEWAY_MULTIPLEX_PROFILES") == b"true"
    ),
    "frameworkProcessIdentity": process_identity(framework_process_id),
    "frameworkRootApiEnabled": (
        framework_environment["values"].get("API_SERVER_ENABLED") == b"true"
    ),
    "frameworkRootGatewayAllowed": (
        framework_environment["values"].get("HERMES_ALLOW_ROOT_GATEWAY") == b"1"
    ),
    "hermesProcessCount": matching_process_count(b"agent-vm-hermes-gateway"),
    "hermesDockerBootstrapProcessCount": sum(
        matching_process_count(command_marker)
        for command_marker in (
            b"entrypoint-dispatch.sh",
            b"stage2-hook.sh",
            b"s6-setuidgid",
        )
    ),
    "managedConfigurationDirectory": str(managed_scope.get_managed_dir()),
    "managedConfigurationReadOnly": managed_configuration_read_only,
    "profileSnapshots": profile_snapshots,
    "rootEnvironmentFileExists": Path("/home/hermes/.hermes/.env").exists(),
    "toolPortalContainsRawProviderCredential": (
        provider_digest in tool_portal_environment["valueDigests"]
    ),
    "toolPortalEnvironmentHasRootGatewayAllowance": (
        "HERMES_ALLOW_ROOT_GATEWAY" in tool_portal_environment["names"]
    ),
    "toolPortalProcessCount": matching_process_count(b"agent-vm-gateway-runtime"),
    "toolPortalProcessIdentity": process_identity(tool_portal_process_id),
}, sort_keys=True))
`,
		},
	);
	if (!result.ok) {
		throw new Error(
			`Hermes live effective-configuration inspection failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	const observation: unknown = JSON.parse(result.stdout);
	expect(observation).toEqual({
		frameworkContainsRawProviderCredential: false,
		frameworkEnvironmentHasDiscordToken: false,
		frameworkEnvironmentHasManagedDir: false,
		frameworkEnvironmentHasManagedLock: false,
		frameworkMultiplexEnabled: true,
		frameworkProcessIdentity: { gid: 0, uid: 0 },
		frameworkRootApiEnabled: true,
		frameworkRootGatewayAllowed: true,
		hermesDockerBootstrapProcessCount: 0,
		hermesProcessCount: 1,
		managedConfigurationDirectory: '/etc/hermes',
		managedConfigurationReadOnly: true,
		profileSnapshots: Object.fromEntries(
			Object.entries(nativeProfileMarkers).map(([profileName, localMarker]) => [
				profileName,
				{
					acceptanceMarker: options.acceptanceMarker,
					fallbackProviders: [
						{
							model: fakeModelName,
							provider: 'custom:hermes-e2e',
						},
					],
					localMarker,
					modelDefault: fakeModelName,
					modelProvider: 'custom:hermes-e2e',
					pluginDisabled: [],
					pluginEnabled: ['agent-vm-tool-portal'],
					providerRouting: { order: ['hermes-e2e'] },
					stateWritable: true,
				},
			]),
		),
		rootEnvironmentFileExists: false,
		toolPortalContainsRawProviderCredential: false,
		toolPortalEnvironmentHasRootGatewayAllowance: false,
		toolPortalProcessCount: 1,
		toolPortalProcessIdentity: { gid: 0, uid: 0 },
	});
	return observation;
}

describeHermesManagedEnvironmentE2e(
	'e2e: Hermes managed common policy reaches the stock root runtime',
	() => {
		let activeHarness: E2eHarnessRuntime | undefined;
		let activeControlTransportProxy: ControlTransportReliabilityProxy | undefined;
		let project: HermesE2eProject | undefined;

		afterAll(async () => {
			try {
				await activeHarness?.close();
			} finally {
				try {
					await activeControlTransportProxy?.close();
				} finally {
					if (project) await removeE2eTempRoot(project.tempRoot);
				}
			}
		});

		it('writes and reads stock files through profile-isolated Tool VMs', async () => {
			const repoRoot = path.resolve(process.cwd());
			const filesystemProject = await scaffoldHermesE2eProject({
				agents: agentIds,
				architecture,
				prefix: 'hermes-managed-filesystem-e2e-',
				zoneId: 'hermes-managed-filesystem-e2e',
			});
			let filesystemHarness: E2eHarnessRuntime | undefined;
			try {
				configureHermesSecrets(filesystemProject);
				const filesystemSystemZone = filesystemProject.systemConfig.zones[0];
				if (
					filesystemSystemZone === undefined ||
					filesystemSystemZone.id !== filesystemProject.zone.id
				) {
					throw new Error('Hermes filesystem E2E loaded zone does not match its projection.');
				}
				filesystemSystemZone.adminAccess = {
					mode: 'secret',
					secret: { source: 'config', value: 'hermes-protected-ssh-e2e-token' },
				};
				await materializeNativeProfileLeaves(filesystemProject);
				await writeFile(
					filesystemProject.zone.gateway.config,
					renderCommonConfiguration(commonAcceptanceMarkers.first),
					'utf8',
				);
				await useLocalHermesGatewayImagePackages({
					architecture,
					profileName: filesystemProject.zone.gateway.imageProfile,
					projectRoot: filesystemProject.tempRoot,
					repoRoot,
					systemConfig: filesystemProject.systemConfig,
				});
				await prepareGatewayE2eProjectImages({ project: filesystemProject });

				const filesystemEpoch = await startManagedHermesEpoch({
					project: filesystemProject,
				});
				filesystemHarness = filesystemEpoch.harness;
				await waitForRootApiHealth({
					gatewayPort: filesystemProject.gatewayPort,
					vm: filesystemEpoch.start.vm,
				});
				await startHermesDeterministicToolCallModelServer({
					filesystemIsolationMarker,
					filesystemMarker,
					frameworkMarker: frameworkGapMarker,
					port: fakeModelPort,
					toolVmMarker: toolVmRecoveryMarker,
					vm: filesystemEpoch.start.vm,
				});
				expect(
					await callHermesProfile({
						apiServerKey: hermesE2eProfileApiServerKey('main'),
						gatewayPort: filesystemProject.gatewayPort,
						profileName: 'main',
						prompt: 'RUN_FILESYSTEM_WRITE_READ_PROBE',
					}),
				).toContain(filesystemMarker);
				expect(
					await callHermesProfile({
						apiServerKey: hermesE2eProfileApiServerKey('beta'),
						gatewayPort: filesystemProject.gatewayPort,
						profileName: 'beta',
						prompt: 'VERIFY_FILESYSTEM_PROFILE_ISOLATION',
					}),
				).toContain(filesystemIsolationMarker);
				expect(filesystemEpoch.toolVmCreateRequests).toHaveLength(2);

				const controllerClient = createControllerClient({
					baseUrl: filesystemHarness.controllerUrl,
				});
				await expect(
					controllerClient.enableZoneSsh(filesystemProject.zone.id, {
						adminToken: 'wrong-hermes-protected-ssh-e2e-token',
					}),
				).rejects.toThrow(/HTTP 403/u);
				const sshAccess = zoneSshAccessResponseSchema.parse(
					await controllerClient.enableZoneSsh(filesystemProject.zone.id, {
						adminToken: 'hermes-protected-ssh-e2e-token',
					}),
				);
				if (
					sshAccess.host === undefined ||
					sshAccess.identityFile === undefined ||
					sshAccess.port === undefined
				) {
					throw new Error('Controller returned incomplete protected Hermes SSH access.');
				}
				const sshResult = await execFileAsync(
					'ssh',
					[
						'-o',
						'StrictHostKeyChecking=no',
						'-o',
						'UserKnownHostsFile=/dev/null',
						'-i',
						sshAccess.identityFile,
						'-p',
						String(sshAccess.port),
						`${sshAccess.user ?? 'root'}@${sshAccess.host}`,
						wrapWithHermesShellEnvironment('printf "%s|%s" "$HERMES_HOME" "$HERMES_TUI_DIR"'),
					],
					{ timeout: 30_000 },
				);
				expect(sshResult.stdout).toBe('/home/hermes/.hermes|/opt/hermes/ui-tui');
			} finally {
				try {
					await filesystemHarness?.close();
				} finally {
					await removeE2eTempRoot(filesystemProject.tempRoot);
				}
			}
		}, 900_000);

		it('discovers managed policy and proves a clean stable restart', async () => {
			const repoRoot = path.resolve(process.cwd());
			project = await scaffoldHermesE2eProject({
				agents: agentIds,
				architecture,
				prefix: 'hermes-managed-base-environment-e2e-',
				zoneId: 'hermes-managed-environment-e2e',
			});
			configureHermesSecrets(project);
			await materializeNativeProfileLeaves(project);
			const expectedNativeLeaves = await readNativeProfileLeaves(project);
			await writeFile(
				project.zone.gateway.config,
				renderCommonConfiguration(commonAcceptanceMarkers.first),
				'utf8',
			);
			await useLocalHermesGatewayImagePackages({
				architecture,
				profileName: project.zone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });

			const firstEpoch = await startManagedHermesEpoch({ project });
			activeHarness = firstEpoch.harness;
			assertManagedGatewayProjection(firstEpoch.start, project);
			expect(firstEpoch.toolVmCreateRequests).toEqual([]);
			await waitForRootApiHealth({
				gatewayPort: project.gatewayPort,
				vm: firstEpoch.start.vm,
			});
			await expectHermesInteractiveShellEnvironment(firstEpoch.start.vm);
			await inspectLiveHermesEpoch({
				acceptanceMarker: commonAcceptanceMarkers.first,
				start: firstEpoch.start,
			});

			await activeHarness.close({ preserveTempRoot: true });
			activeHarness = undefined;
			expect(firstEpoch.start.vm.getHostProcessId()).toBeNull();
			await writeFile(
				project.zone.gateway.config,
				renderCommonConfiguration(commonAcceptanceMarkers.second),
				'utf8',
			);
			expect(await readNativeProfileLeaves(project)).toEqual(expectedNativeLeaves);

			const secondEpoch = await startManagedHermesEpoch({
				enableControlTransportIsolation: true,
				project,
			});
			activeHarness = secondEpoch.harness;
			activeControlTransportProxy = secondEpoch.controlTransportProxy;
			if (activeControlTransportProxy === undefined) {
				throw new Error('Hermes recovery E2E did not create its control transport proxy.');
			}
			expect(secondEpoch.toolVmCreateRequests).toEqual([]);
			await waitForRootApiHealth({
				gatewayPort: project.gatewayPort,
				vm: secondEpoch.start.vm,
			});
			await inspectLiveHermesEpoch({
				acceptanceMarker: commonAcceptanceMarkers.second,
				start: secondEpoch.start,
			});
			await startHermesDeterministicToolCallModelServer({
				filesystemIsolationMarker,
				filesystemMarker,
				frameworkMarker: frameworkGapMarker,
				port: fakeModelPort,
				toolVmMarker: toolVmRecoveryMarker,
				vm: secondEpoch.start.vm,
			});
			await expectHermesApiKeyIsolation(project.gatewayPort);
			expect(
				await callHermesProfile({
					apiServerKey: hermesE2eProfileApiServerKey('main'),
					gatewayPort: project.gatewayPort,
					profileName: 'main',
					prompt: 'RUN_FILESYSTEM_WRITE_READ_PROBE',
				}),
			).toContain(filesystemMarker);
			expect(
				await callHermesProfile({
					apiServerKey: hermesE2eProfileApiServerKey('beta'),
					gatewayPort: project.gatewayPort,
					profileName: 'beta',
					prompt: 'VERIFY_FILESYSTEM_PROFILE_ISOLATION',
				}),
			).toContain(filesystemIsolationMarker);
			expect(secondEpoch.toolVmCreateRequests).toHaveLength(2);

			const frameworkPort =
				secondEpoch.start.expectedCohort.ingressIntent.frameworkRootRoute.guestPort;
			const toolPortalPort = secondEpoch.start.expectedCohort.ingressIntent.controlRoute.guestPort;
			const frameworkIdentityBefore = await readManagedGatewaySiblingProcessIdentity({
				gatewayVm: secondEpoch.start.vm,
				guestPort: frameworkPort,
				role: 'framework',
			});
			const toolPortalIdentityBefore = await readManagedGatewaySiblingProcessIdentity({
				gatewayVm: secondEpoch.start.vm,
				guestPort: toolPortalPort,
				role: 'tool-portal',
			});
			const initialControlDiagnostics = secondEpoch.start.controlSession.getDiagnostics();
			const initialAttachmentGeneration = initialControlDiagnostics.attachmentGeneration;
			const initialSessionId = initialControlDiagnostics.lastHelloResponse?.sessionId;
			if (
				initialAttachmentGeneration === undefined ||
				initialSessionId === undefined ||
				initialControlDiagnostics.lastHelloResponse?.outcome !== 'accepted'
			) {
				throw new Error(
					`Expected an accepted Hermes control session before interruption: ${JSON.stringify(initialControlDiagnostics)}`,
				);
			}
			expect(secondEpoch.start.vm.getHostProcessId()).toBe(secondEpoch.start.qemuPid);
			expect(
				await readManagedGatewaySiblingProcessIdentity({
					gatewayVm: secondEpoch.start.vm,
					guestPort: frameworkPort,
					role: 'framework',
				}),
			).toEqual(frameworkIdentityBefore);
			expect(
				await readManagedGatewaySiblingProcessIdentity({
					gatewayVm: secondEpoch.start.vm,
					guestPort: toolPortalPort,
					role: 'tool-portal',
				}),
			).toEqual(toolPortalIdentityBefore);
			expect(await readNativeProfileLeaves(project)).toEqual(expectedNativeLeaves);
			expect(secondEpoch.start.vm.id).not.toBe(firstEpoch.start.vm.id);
			expect(secondEpoch.start.qemuPid).not.toBe(firstEpoch.start.qemuPid);
			expect(secondEpoch.start.expectedCohort.fence.gatewayEpoch).not.toBe(
				firstEpoch.start.expectedCohort.fence.gatewayEpoch,
			);
			expect(secondEpoch.start.expectedCohort.frameworkIdentity.frameworkEpoch).not.toBe(
				firstEpoch.start.expectedCohort.frameworkIdentity.frameworkEpoch,
			);
			expect(secondEpoch.start.expectedCohort.toolPortalIdentity.processEpoch).not.toBe(
				firstEpoch.start.expectedCohort.toolPortalIdentity.processEpoch,
			);
			expect(secondEpoch.start.expectedCohort.toolPortalIdentity.runtimeEpoch).not.toBe(
				firstEpoch.start.expectedCohort.toolPortalIdentity.runtimeEpoch,
			);
			if (!runHermesControlReattachmentStress) {
				return;
			}

			const isolation = activeControlTransportProxy.isolate();
			const postBudgetAttempt = await activeControlTransportProxy.waitForRejectedConnection({
				minimumObservedAtMs: isolation.startedAtMs + GATEWAY_CONTROL_RECONNECT_DEADLINE_MS + 1,
				minimumRejectedConnectionCount:
					isolation.rejectedConnectionCount + GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS + 1,
				timeoutMs: GATEWAY_CONTROL_RECONNECT_DEADLINE_MS * 3,
			});
			expect(postBudgetAttempt.observedAtMs - isolation.startedAtMs).toBeGreaterThan(
				GATEWAY_CONTROL_RECONNECT_DEADLINE_MS,
			);
			expect(
				await callHermesProfile({
					apiServerKey: hermesE2eProfileApiServerKey('main'),
					gatewayPort: project.gatewayPort,
					profileName: 'main',
					prompt: 'NO_TOOL_FRAMEWORK_PROBE',
				}),
			).toContain(frameworkGapMarker);
			expect(secondEpoch.start.controlSession.getDiagnostics()).toMatchObject({
				connected: false,
				reconnectExhausted: false,
			});
			activeControlTransportProxy.restore();
			await waitForFreshAcceptedControlSession({
				controlSession: secondEpoch.start.controlSession,
				minimumAttachmentGeneration: initialAttachmentGeneration + 1,
				previousSessionId: initialSessionId,
			});
			expect(
				await callHermesProfile({
					apiServerKey: hermesE2eProfileApiServerKey('main'),
					gatewayPort: project.gatewayPort,
					profileName: 'main',
					prompt: 'RUN_TOOL_VM_RECOVERY_PROBE',
				}),
			).toContain(toolVmRecoveryMarker);
			expect(secondEpoch.toolVmCreateRequests).toHaveLength(2);
			expect(secondEpoch.start.vm.getHostProcessId()).toBe(secondEpoch.start.qemuPid);
			expect(
				await readManagedGatewaySiblingProcessIdentity({
					gatewayVm: secondEpoch.start.vm,
					guestPort: frameworkPort,
					role: 'framework',
				}),
			).toEqual(frameworkIdentityBefore);
			expect(
				await readManagedGatewaySiblingProcessIdentity({
					gatewayVm: secondEpoch.start.vm,
					guestPort: toolPortalPort,
					role: 'tool-portal',
				}),
			).toEqual(toolPortalIdentityBefore);
		}, 900_000);
	},
);
