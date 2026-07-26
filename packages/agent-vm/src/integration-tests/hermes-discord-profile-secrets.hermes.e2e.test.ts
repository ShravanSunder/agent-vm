import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

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
import {
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

const architecture = currentE2eArchitecture();
const runHermesDiscordProfileSecretsE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeHermesDiscordProfileSecretsE2e = runHermesDiscordProfileSecretsE2e
	? describe
	: describe.skip;

const agentIds = ['clawfest', 'beta'] as const;
const discordSecretEnvironmentNames = {
	beta: 'DISCORD_BOT_TOKEN_BETA',
	clawfest: 'DISCORD_BOT_TOKEN_CLAWFEST',
} as const;
const mediatedSecretEnvironmentNames = {
	beta: 'HERMES_E2E_MEDIATED_SECRET_BETA',
	clawfest: 'HERMES_E2E_MEDIATED_SECRET_CLAWFEST',
} as const;
const mediatedSecretProfileTargetName = 'OPENROUTER_API_KEY';
const mediatedHost = 'hermes-profile-secrets.vm.host';
const durableSiblingFileName = 'durable-profile-state.txt';

type AgentId = (typeof agentIds)[number];

interface GenerationCanaries {
	readonly discordByAgent: Readonly<Record<AgentId, string>>;
	readonly mediatedByAgent: Readonly<Record<AgentId, string>>;
}

interface GatewayStartObservation {
	readonly request: ManagedVmCreateRequest;
	readonly vm: GatewayZoneVmOperations;
}

interface GuestProfileFileObservation {
	readonly discordValueDigest: string;
	readonly mode: string;
	readonly profileName: AgentId;
	readonly providerValueDigest: string;
	readonly regularFile: boolean;
}

interface GuestEnvironmentObservation {
	readonly environmentScriptsRemain: boolean;
	readonly toolPortalContainsMediatedPlaceholder: boolean;
	readonly toolPortalContainsRawValue: boolean;
	readonly toolPortalContainsSourceName: boolean;
	readonly vmWideContainsRawValue: boolean;
	readonly vmWideContainsSourceName: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function createGenerationCanaries(generation: 'first' | 'second'): GenerationCanaries {
	return {
		discordByAgent: {
			beta: `non-secret-beta-${generation}-generation-canary`,
			clawfest: `non-secret-clawfest-${generation}-generation-canary`,
		},
		mediatedByAgent: {
			beta: `non-secret-mediated-beta-${generation}-generation-canary`,
			clawfest: `non-secret-mediated-clawfest-${generation}-generation-canary`,
		},
	};
}

async function configureHermesProfileSecrets(project: HermesE2eProject): Promise<void> {
	Object.assign(project.zone.gateway, {
		profileSecretProjectionsByAgent: Object.fromEntries(
			agentIds.map((agentId) => [
				agentId,
				{
					DISCORD_BOT_TOKEN: discordSecretEnvironmentNames[agentId],
					[mediatedSecretProfileTargetName]: mediatedSecretEnvironmentNames[agentId],
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
	for (const agentId of agentIds) {
		const secretEnvironmentName = mediatedSecretEnvironmentNames[agentId];
		project.zone.secrets[secretEnvironmentName] = {
			audience: 'gateway',
			envVar: secretEnvironmentName,
			hosts: [mediatedHost],
			injection: 'http-mediation',
			source: 'environment',
		};
	}
	project.zone.egressHosts = [
		...(project.zone.egressHosts ?? []),
		{ audience: 'gateway', host: mediatedHost },
	];
}

function generationSecretInputs(generationCanaries: GenerationCanaries): Record<string, string> {
	return {
		[discordSecretEnvironmentNames.beta]: generationCanaries.discordByAgent.beta,
		[discordSecretEnvironmentNames.clawfest]: generationCanaries.discordByAgent.clawfest,
		[mediatedSecretEnvironmentNames.beta]: generationCanaries.mediatedByAgent.beta,
		[mediatedSecretEnvironmentNames.clawfest]: generationCanaries.mediatedByAgent.clawfest,
		GITHUB_TOKEN: 'unused-hermes-profile-secrets-e2e-token',
	};
}

function requireProfileFileObservations(output: string): readonly GuestProfileFileObservation[] {
	const parsed: unknown = JSON.parse(output);
	if (
		!Array.isArray(parsed) ||
		parsed.some(
			(observation) =>
				!isObjectRecord(observation) ||
				typeof observation.discordValueDigest !== 'string' ||
				typeof observation.mode !== 'string' ||
				typeof observation.profileName !== 'string' ||
				typeof observation.providerValueDigest !== 'string' ||
				typeof observation.regularFile !== 'boolean',
		)
	) {
		throw new Error('Hermes guest profile-file observation had an invalid safe result shape.');
	}
	return parsed.map((observation) => ({
		discordValueDigest: String(observation.discordValueDigest),
		mode: String(observation.mode),
		profileName: observation.profileName as AgentId,
		providerValueDigest: String(observation.providerValueDigest),
		regularFile: Boolean(observation.regularFile),
	}));
}

async function inspectGuestProfileFiles(
	vm: GatewayZoneVmOperations,
): Promise<readonly GuestProfileFileObservation[]> {
	const result = await vm.exec(`
python3 - <<'PY'
import hashlib
import json
import os
import stat

observations = []
for profile_name in ("clawfest", "beta"):
    file_path = f"/home/hermes/.hermes/profiles/{profile_name}/.env"
    file_stat = os.lstat(file_path)
    entries = {
        key: value
        for key, value in (
            line.rstrip("\\n").split("=", 1)
            for line in open(file_path, encoding="utf-8")
            if "=" in line
        )
    }
    observations.append({
        "discordValueDigest": hashlib.sha256(
            entries["DISCORD_BOT_TOKEN"].encode()
        ).hexdigest(),
        "mode": format(stat.S_IMODE(file_stat.st_mode), "03o"),
        "profileName": profile_name,
        "providerValueDigest": hashlib.sha256(
            entries["OPENROUTER_API_KEY"].encode()
        ).hexdigest(),
        "regularFile": stat.S_ISREG(file_stat.st_mode) and not stat.S_ISLNK(file_stat.st_mode),
    })
print(json.dumps(observations, sort_keys=True))
PY
`);
	if (!result.ok) {
		throw new Error(
			`Hermes guest profile-file inspection failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	return requireProfileFileObservations(result.stdout);
}

function requireEnvironmentObservation(output: string): GuestEnvironmentObservation {
	const parsed: unknown = JSON.parse(output);
	if (
		!isObjectRecord(parsed) ||
		typeof parsed.environmentScriptsRemain !== 'boolean' ||
		typeof parsed.toolPortalContainsMediatedPlaceholder !== 'boolean' ||
		typeof parsed.toolPortalContainsRawValue !== 'boolean' ||
		typeof parsed.toolPortalContainsSourceName !== 'boolean' ||
		typeof parsed.vmWideContainsRawValue !== 'boolean' ||
		typeof parsed.vmWideContainsSourceName !== 'boolean'
	) {
		throw new Error('Hermes guest environment observation had an invalid safe result shape.');
	}
	return {
		environmentScriptsRemain: parsed.environmentScriptsRemain,
		toolPortalContainsMediatedPlaceholder: parsed.toolPortalContainsMediatedPlaceholder,
		toolPortalContainsRawValue: parsed.toolPortalContainsRawValue,
		toolPortalContainsSourceName: parsed.toolPortalContainsSourceName,
		vmWideContainsRawValue: parsed.vmWideContainsRawValue,
		vmWideContainsSourceName: parsed.vmWideContainsSourceName,
	};
}

async function inspectGuestEnvironments(options: {
	readonly canaries: GenerationCanaries;
	readonly mediatedGuestPlaceholdersByAgent: Readonly<Record<AgentId, string>>;
	readonly vm: GatewayZoneVmOperations;
}): Promise<GuestEnvironmentObservation> {
	const rawValueDigests = [
		...Object.values(options.canaries.discordByAgent),
		...Object.values(options.canaries.mediatedByAgent),
	].map(sha256);
	const mediatedGuestPlaceholderDigests = Object.values(
		options.mediatedGuestPlaceholdersByAgent,
	).map(sha256);
	const result = await options.vm.exec(
		[
			'python3',
			'-',
			...rawValueDigests.map((digest) => `--raw-value-digest=${digest}`),
			...mediatedGuestPlaceholderDigests.map((digest) => `--mediated-placeholder-digest=${digest}`),
		],
		{
			stdin: `
import hashlib
import json
import os
import sys

raw_value_digests = {
    argument.removeprefix("--raw-value-digest=")
    for argument in sys.argv[1:]
    if argument.startswith("--raw-value-digest=")
}
mediated_placeholder_digests = {
    argument.removeprefix("--mediated-placeholder-digest=")
    for argument in sys.argv[1:]
    if argument.startswith("--mediated-placeholder-digest=")
}
source_names = {
    b"DISCORD_BOT_TOKEN_CLAWFEST",
    b"DISCORD_BOT_TOKEN_BETA",
    b"HERMES_E2E_MEDIATED_SECRET_CLAWFEST",
    b"HERMES_E2E_MEDIATED_SECRET_BETA",
}

def inspect_environment(process_id):
    try:
        entries = [
            entry
            for entry in open(f"/proc/{process_id}/environ", "rb").read().split(b"\\0")
            if entry
        ]
    except (FileNotFoundError, PermissionError):
        return {"containsRawValue": False, "containsSourceName": False}
    names = {entry.partition(b"=")[0] for entry in entries}
    values = [entry.partition(b"=")[2] for entry in entries]
    return {
        "containsMediatedPlaceholder": any(
            hashlib.sha256(value).hexdigest() in mediated_placeholder_digests
            for value in values
        ),
        "containsRawValue": any(
            hashlib.sha256(value).hexdigest() in raw_value_digests
            for value in values
        ),
        "containsSourceName": bool(names & source_names),
    }

tool_portal_process_ids = []
for process_id in os.listdir("/proc"):
    if not process_id.isdigit():
        continue
    try:
        command_line = open(f"/proc/{process_id}/cmdline", "rb").read()
    except (FileNotFoundError, PermissionError):
        continue
    if b"agent-vm-gateway-runtime" in command_line:
        tool_portal_process_ids.append(process_id)
if len(tool_portal_process_ids) != 1:
    raise RuntimeError(
        f"expected one Tool Portal process, observed {len(tool_portal_process_ids)}"
    )

vm_wide = inspect_environment("1")
tool_portal = inspect_environment(tool_portal_process_ids[0])
print(json.dumps({
    "environmentScriptsRemain": any(
        os.path.exists(path)
        for path in (
            "/run/agent-vm/managed-gateway-environment/framework.environment.sh",
            "/run/agent-vm/managed-gateway-environment/tool-portal.environment.sh",
        )
    ),
    "toolPortalContainsMediatedPlaceholder": tool_portal["containsMediatedPlaceholder"],
    "toolPortalContainsRawValue": tool_portal["containsRawValue"],
    "toolPortalContainsSourceName": tool_portal["containsSourceName"],
    "vmWideContainsRawValue": vm_wide["containsRawValue"],
    "vmWideContainsSourceName": vm_wide["containsSourceName"],
}, sort_keys=True))
`,
		},
	);
	if (!result.ok) {
		throw new Error(
			`Hermes guest environment inspection failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	return requireEnvironmentObservation(result.stdout);
}

async function pathExists(filePath: string): Promise<boolean> {
	return await access(filePath)
		.then(() => true)
		.catch((error: unknown): false => {
			if (isObjectRecord(error) && error.code === 'ENOENT') return false;
			throw error;
		});
}

async function collectCanaryLeakPaths(
	rootPaths: readonly string[],
	canaries: readonly string[],
): Promise<readonly string[]> {
	const canaryBuffers = canaries.map((canary) => Buffer.from(canary));
	const leakedPaths: string[] = [];
	const visit = async (candidatePath: string): Promise<void> => {
		const candidateStat = await lstat(candidatePath).catch((error: unknown) => {
			if (isObjectRecord(error) && error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (candidateStat === undefined || candidateStat.isSymbolicLink()) return;
		if (candidateStat.isDirectory()) {
			const childNames = await readdir(candidatePath);
			for (const childName of childNames) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- deterministic bounded durable-tree inspection
				await visit(path.join(candidatePath, childName));
			}
			return;
		}
		if (!candidateStat.isFile()) return;
		const contents = await readFile(candidatePath);
		if (canaryBuffers.some((canary) => contents.includes(canary))) {
			leakedPaths.push(candidatePath);
		}
	};
	for (const rootPath of rootPaths) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- deterministic bounded durable-root inspection
		await visit(rootPath);
	}
	return leakedPaths;
}

async function inspectDurableProfileState(options: {
	readonly durableSiblingPaths: Readonly<Record<AgentId, string>>;
	readonly stateDir: string;
}): Promise<
	readonly {
		readonly durableSiblingContent: string;
		readonly lowerEnvironmentFileExists: boolean;
		readonly profileName: AgentId;
	}[]
> {
	return await Promise.all(
		agentIds.map(async (agentId) => ({
			durableSiblingContent: await readFile(options.durableSiblingPaths[agentId], 'utf8'),
			lowerEnvironmentFileExists: await pathExists(
				path.join(options.stateDir, 'profiles', agentId, '.env'),
			),
			profileName: agentId,
		})),
	);
}

async function startGeneration(options: {
	readonly canaries: GenerationCanaries;
	readonly project: HermesE2eProject;
}): Promise<{
	readonly gateway: GatewayStartObservation;
	readonly harness: E2eHarnessRuntime;
}> {
	let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
	let gatewayVm: GatewayZoneVmOperations | undefined;
	const harness = await startE2eControllerRuntime({
		secrets: generationSecretInputs(options.canaries),
		startGatewayZone: async (startOptions) => {
			const result = await startE2eGatewayZone(startOptions, {
				onManagedVmCreateRequest: (request) => {
					managedVmCreateRequest = request;
				},
			});
			if (result.executionModel !== 'managed-gateway') {
				throw new Error('Hermes profile-secret E2E requires a managed Gateway boot.');
			}
			gatewayVm = result.vm;
			return result;
		},
		startOptions: {
			systemConfig: options.project.systemConfig,
			zoneIds: [options.project.zone.id],
		},
	});
	if (managedVmCreateRequest === undefined || gatewayVm === undefined) {
		await harness.close({ preserveTempRoot: true });
		throw new Error('Hermes profile-secret E2E did not observe the managed Gateway boot.');
	}
	return {
		gateway: {
			request: managedVmCreateRequest,
			vm: gatewayVm,
		},
		harness,
	};
}

function assertSafeManagedVmRequest(options: {
	readonly canaries: GenerationCanaries;
	readonly request: ManagedVmCreateRequest;
}): void {
	const rawDiscordValues = Object.values(options.canaries.discordByAgent);
	const rawMediatedValues = Object.values(options.canaries.mediatedByAgent);
	expect(Object.keys(options.request.environment)).not.toContain(
		discordSecretEnvironmentNames.clawfest,
	);
	expect(Object.keys(options.request.environment)).not.toContain(
		discordSecretEnvironmentNames.beta,
	);
	expect(
		Object.values(options.request.environment).some((value) => rawDiscordValues.includes(value)),
	).toBe(false);
	for (const mediatedSecretEnvironmentName of Object.values(mediatedSecretEnvironmentNames)) {
		expect(Object.keys(options.request.environment)).not.toContain(mediatedSecretEnvironmentName);
	}
	expect(
		Object.values(options.request.environment).some((value) => rawMediatedValues.includes(value)),
	).toBe(false);
	const hermesHomeMount = options.request.mounts['/home/hermes/.hermes'];
	expect(
		hermesHomeMount?.kind === 'shadow' ? [...hermesHomeMount.temporaryFilesystems].toSorted() : [],
	).toEqual(['/profiles/beta/.env', '/profiles/clawfest/.env']);
	const mediatedGuestPlaceholders = agentIds.map((agentId) => {
		const mediatedDescriptor = options.request.mediatedSecrets.find(
			(descriptor) => descriptor.environmentVariable === mediatedSecretEnvironmentNames[agentId],
		);
		expect(mediatedDescriptor).toBeDefined();
		expect(mediatedDescriptor?.allowedHosts).toEqual([mediatedHost]);
		expect(mediatedDescriptor?.guestPlaceholder).toEqual(expect.any(String));
		expect(mediatedDescriptor?.guestPlaceholder).not.toBe('');
		expect(mediatedDescriptor?.guestPlaceholder).not.toBe(
			options.canaries.mediatedByAgent[agentId],
		);
		expect(mediatedDescriptor?.value).toBe(options.canaries.mediatedByAgent[agentId]);
		return mediatedDescriptor?.guestPlaceholder;
	});
	expect(new Set(mediatedGuestPlaceholders).size).toBe(agentIds.length);
}

function requireMediatedGuestPlaceholder(
	request: ManagedVmCreateRequest,
	agentId: AgentId,
): string {
	const descriptor = request.mediatedSecrets.find(
		(candidate) => candidate.environmentVariable === mediatedSecretEnvironmentNames[agentId],
	);
	if (descriptor === undefined) {
		throw new Error(`Hermes profile-secret E2E omitted the ${agentId} mediated projection.`);
	}
	if (typeof descriptor.guestPlaceholder !== 'string' || descriptor.guestPlaceholder.length === 0) {
		throw new Error(`Hermes profile-secret E2E omitted the ${agentId} mediated placeholder.`);
	}
	return descriptor.guestPlaceholder;
}

function requireMediatedGuestPlaceholdersByAgent(
	request: ManagedVmCreateRequest,
): Readonly<Record<AgentId, string>> {
	return {
		beta: requireMediatedGuestPlaceholder(request, 'beta'),
		clawfest: requireMediatedGuestPlaceholder(request, 'clawfest'),
	};
}

function assertGuestProfileFiles(
	observations: readonly GuestProfileFileObservation[],
	canaries: GenerationCanaries,
	mediatedGuestPlaceholdersByAgent: Readonly<Record<AgentId, string>>,
): void {
	expect(
		observations.map((observation) => ({
			discordValueDigest: observation.discordValueDigest,
			mode: observation.mode,
			profileName: observation.profileName,
			providerValueDigest: observation.providerValueDigest,
			regularFile: observation.regularFile,
		})),
	).toEqual(
		agentIds.map((agentId) => ({
			discordValueDigest: sha256(canaries.discordByAgent[agentId]),
			mode: '600',
			profileName: agentId,
			providerValueDigest: sha256(mediatedGuestPlaceholdersByAgent[agentId]),
			regularFile: true,
		})),
	);
	expect(new Set(observations.map((observation) => observation.providerValueDigest)).size).toBe(
		agentIds.length,
	);
	expect(observations.map((observation) => observation.providerValueDigest)).not.toContain(
		sha256(canaries.mediatedByAgent.beta),
	);
	expect(observations.map((observation) => observation.providerValueDigest)).not.toContain(
		sha256(canaries.mediatedByAgent.clawfest),
	);
}

describeHermesDiscordProfileSecretsE2e(
	'e2e: Hermes Discord profile secrets remain memory-only across Gateway boots',
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

		it('rebuilds exact profile files from protected service inputs without durable leakage', async () => {
			const repoRoot = path.resolve(process.cwd());
			const firstGeneration = createGenerationCanaries('first');
			const secondGeneration = createGenerationCanaries('second');
			project = await scaffoldHermesE2eProject({
				agents: agentIds,
				architecture,
				prefix: 'hermes-managed-base-environment-e2e-',
				zoneId: 'hermes-discord-profile-secrets-e2e',
			});
			await configureHermesProfileSecrets(project);
			const durableSiblingPaths = Object.fromEntries(
				agentIds.map((agentId) => [
					agentId,
					path.join(
						project?.zone.gateway.stateDir ?? '',
						'profiles',
						agentId,
						durableSiblingFileName,
					),
				]),
			) as Readonly<Record<AgentId, string>>;
			await Promise.all(
				agentIds.map(async (agentId) => {
					const durableSiblingPath = durableSiblingPaths[agentId];
					await mkdir(path.dirname(durableSiblingPath), { recursive: true });
					await writeFile(durableSiblingPath, `durable-${agentId}\n`, 'utf8');
				}),
			);
			await useLocalHermesGatewayImagePackages({
				architecture,
				profileName: project.zone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });

			const firstBoot = await startGeneration({
				canaries: firstGeneration,
				project,
			});
			activeHarness = firstBoot.harness;
			assertSafeManagedVmRequest({
				canaries: firstGeneration,
				request: firstBoot.gateway.request,
			});
			const firstBootMediatedGuestPlaceholders = requireMediatedGuestPlaceholdersByAgent(
				firstBoot.gateway.request,
			);
			assertGuestProfileFiles(
				await inspectGuestProfileFiles(firstBoot.gateway.vm),
				firstGeneration,
				firstBootMediatedGuestPlaceholders,
			);
			expect(
				await inspectGuestEnvironments({
					canaries: firstGeneration,
					mediatedGuestPlaceholdersByAgent: firstBootMediatedGuestPlaceholders,
					vm: firstBoot.gateway.vm,
				}),
			).toEqual({
				environmentScriptsRemain: false,
				toolPortalContainsMediatedPlaceholder: false,
				toolPortalContainsRawValue: false,
				toolPortalContainsSourceName: false,
				vmWideContainsRawValue: false,
				vmWideContainsSourceName: false,
			});
			expect(
				await inspectDurableProfileState({
					durableSiblingPaths,
					stateDir: project.zone.gateway.stateDir,
				}),
			).toEqual(
				agentIds.map((agentId) => ({
					durableSiblingContent: `durable-${agentId}\n`,
					lowerEnvironmentFileExists: false,
					profileName: agentId,
				})),
			);

			await activeHarness.close({ preserveTempRoot: true });
			activeHarness = undefined;
			expect(firstBoot.gateway.vm.getHostProcessId()).toBeNull();

			const secondBoot = await startGeneration({
				canaries: secondGeneration,
				project,
			});
			activeHarness = secondBoot.harness;
			assertSafeManagedVmRequest({
				canaries: secondGeneration,
				request: secondBoot.gateway.request,
			});
			const secondBootMediatedGuestPlaceholders = requireMediatedGuestPlaceholdersByAgent(
				secondBoot.gateway.request,
			);
			assertGuestProfileFiles(
				await inspectGuestProfileFiles(secondBoot.gateway.vm),
				secondGeneration,
				secondBootMediatedGuestPlaceholders,
			);
			for (const agentId of agentIds) {
				expect(secondBootMediatedGuestPlaceholders[agentId]).not.toBe(
					firstBootMediatedGuestPlaceholders[agentId],
				);
			}
			expect(
				await inspectGuestEnvironments({
					canaries: secondGeneration,
					mediatedGuestPlaceholdersByAgent: secondBootMediatedGuestPlaceholders,
					vm: secondBoot.gateway.vm,
				}),
			).toEqual({
				environmentScriptsRemain: false,
				toolPortalContainsMediatedPlaceholder: false,
				toolPortalContainsRawValue: false,
				toolPortalContainsSourceName: false,
				vmWideContainsRawValue: false,
				vmWideContainsSourceName: false,
			});
			expect(
				await inspectDurableProfileState({
					durableSiblingPaths,
					stateDir: project.zone.gateway.stateDir,
				}),
			).toEqual(
				agentIds.map((agentId) => ({
					durableSiblingContent: `durable-${agentId}\n`,
					lowerEnvironmentFileExists: false,
					profileName: agentId,
				})),
			);
			expect(
				await collectCanaryLeakPaths(
					[
						project.zone.gateway.stateDir,
						project.zone.gateway.zoneFilesDir,
						project.zone.gateway.zoneRuntimeDir,
						project.systemConfig.controllerStateDir,
					],
					[
						...Object.values(firstGeneration.discordByAgent),
						...Object.values(firstGeneration.mediatedByAgent),
						...Object.values(secondGeneration.discordByAgent),
						...Object.values(secondGeneration.mediatedByAgent),
					],
				),
			).toEqual([]);
		}, 900_000);
	},
);
