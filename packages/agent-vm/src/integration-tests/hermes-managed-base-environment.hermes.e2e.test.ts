/* oxlint-disable eslint/no-await-in-loop -- live readiness uses bounded sequential protocol probes */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

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
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
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

interface ManagedGatewayStartObservation {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly managedVmCreateRequest: ManagedVmCreateRequest;
	readonly qemuPid: number;
	readonly vm: Pick<GatewayZoneVmOperations, 'exec' | 'getHostProcessId' | 'id'>;
}

interface ManagedHermesEpoch {
	readonly harness: E2eHarnessRuntime;
	readonly start: ManagedGatewayStartObservation;
	readonly toolVmCreateRequests: readonly ManagedVmCreateRequest[];
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function renderCommonConfiguration(acceptanceMarker: string): string {
	return renderHermesManagedE2eConfiguration({
		acceptanceMarker,
		contextLength: fakeModelContextLength,
		fakeModelHost,
		fakeModelName,
	});
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
			await writeFile(
				configurationPath,
				`agent_vm_profile_marker: ${nativeProfileMarkers[profileName as keyof typeof nativeProfileMarkers]}\n`,
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
		[discordSecretEnvironmentNames.beta]: discordSecretCanaries.beta,
		[discordSecretEnvironmentNames.main]: discordSecretCanaries.main,
		[providerCredentialEnvironmentName]: providerCredentialCanary,
		GITHUB_TOKEN: 'unused-hermes-managed-environment-token',
	};
}

async function startManagedHermesEpoch(options: {
	readonly project: HermesE2eProject;
}): Promise<ManagedHermesEpoch> {
	let managedGatewayStart: ManagedGatewayStartObservation | undefined;
	const toolVmCreateRequests: ManagedVmCreateRequest[] = [];
	const harness = await startE2eControllerRuntime({
		onControllerManagedVmCreateRequest: (request) => {
			toolVmCreateRequests.push(request);
		},
		secrets: resolvedHermesSecrets(),
		startGatewayZone: async (startOptions) => {
			let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
			const result = await startE2eGatewayZone(startOptions, {
				onManagedVmCreateRequest: (request) => {
					managedVmCreateRequest = request;
				},
			});
			if (result.executionModel !== 'managed-gateway' || managedVmCreateRequest === undefined) {
				throw new Error('Hermes managed environment E2E requires a managed Gateway image boot.');
			}
			const qemuPid = result.vm.getHostProcessId();
			if (qemuPid === null) {
				throw new Error('Managed Hermes Gateway start omitted its QEMU pid.');
			}
			managedGatewayStart = {
				expectedCohort: result.expectedCohort,
				managedVmCreateRequest,
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
	if (managedGatewayStart === undefined) {
		await harness.close({ preserveTempRoot: true });
		throw new Error('Hermes managed environment E2E did not observe the managed Gateway start.');
	}
	return {
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
			'/opt/agent-vm/hermes-venv/bin/python',
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
        profile_snapshots[profile_name] = {
            "acceptanceMarker": configuration.get("agent_vm_acceptance_marker"),
            "fallbackProviders": gateway_run.get_fallback_chain(configuration),
            "localMarker": configuration.get("agent_vm_profile_marker"),
            "modelDefault": model.get("default"),
            "modelProvider": model.get("provider"),
            "pluginDisabled": plugins.get("disabled"),
            "pluginEnabled": plugins.get("enabled"),
            "providerRouting": gateway_run.GatewayRunner._load_provider_routing(),
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
    "frameworkRootApiEnabled": (
        framework_environment["values"].get("API_SERVER_ENABLED") == b"true"
    ),
    "hermesProcessCount": matching_process_count(b"agent-vm-hermes-gateway"),
    "managedConfigurationDirectory": str(managed_scope.get_managed_dir()),
    "managedConfigurationReadOnly": managed_configuration_read_only,
    "profileSnapshots": profile_snapshots,
    "rootEnvironmentFileExists": Path("/home/hermes/.hermes/.env").exists(),
    "toolPortalContainsRawProviderCredential": (
        provider_digest in tool_portal_environment["valueDigests"]
    ),
    "toolPortalProcessCount": matching_process_count(b"agent-vm-gateway-runtime"),
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
		frameworkRootApiEnabled: true,
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
				},
			]),
		),
		rootEnvironmentFileExists: false,
		toolPortalContainsRawProviderCredential: false,
		toolPortalProcessCount: 1,
	});
	return observation;
}

describeHermesManagedEnvironmentE2e(
	'e2e: Hermes managed common policy reaches the stock root runtime',
	() => {
		let activeHarness: E2eHarnessRuntime | undefined;
		let project: HermesE2eProject | undefined;

		afterAll(async () => {
			try {
				await activeHarness?.close();
			} finally {
				if (project) await removeE2eTempRoot(project.tempRoot);
			}
		});

		it('discovers managed policy and applies marker updates across restart', async () => {
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

			const secondEpoch = await startManagedHermesEpoch({ project });
			activeHarness = secondEpoch.harness;
			assertManagedGatewayProjection(secondEpoch.start, project);
			expect(secondEpoch.toolVmCreateRequests).toEqual([]);
			await waitForRootApiHealth({
				gatewayPort: project.gatewayPort,
				vm: secondEpoch.start.vm,
			});
			await inspectLiveHermesEpoch({
				acceptanceMarker: commonAcceptanceMarkers.second,
				start: secondEpoch.start,
			});
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
		}, 900_000);
	},
);
