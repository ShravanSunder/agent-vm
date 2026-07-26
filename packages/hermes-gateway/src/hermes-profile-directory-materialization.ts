import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GatewayZoneConfig, ManagedGatewayLifecycle } from '@agent-vm/gateway-lifecycle';

import {
	loadHermesManagedConfiguration,
	validateHermesNativeConfigurationFile,
} from './hermes-managed-configuration.js';

const hermesProfileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const hermesProfilesDirectoryName = 'profiles';
const hermesRootConfigurationFileName = 'config.yaml';
type FileSystemEntryStatus = Awaited<ReturnType<typeof lstat>>;
type GatewayHostStateSecretResolver = Parameters<
	NonNullable<ManagedGatewayLifecycle['prepareHostState']>
>[1];
type UnknownRecord = Readonly<Record<string, unknown>>;

function isObjectRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function readPathStatus(filePath: string): Promise<FileSystemEntryStatus | undefined> {
	return await lstat(filePath).catch((error: unknown): undefined => {
		if (isMissingPathError(error)) {
			return undefined;
		}
		throw error;
	});
}

function requireHermesProfileNames(zone: GatewayZoneConfig): readonly string[] {
	if (zone.gateway.type !== 'hermes') {
		throw new Error(
			`Hermes profile materialization cannot prepare gateway type '${zone.gateway.type}'.`,
		);
	}

	const profilesByAgent: unknown = zone.gateway.profilesByAgent;
	if (!isObjectRecord(profilesByAgent)) {
		throw new Error('Managed Hermes profilesByAgent must be an object.');
	}
	const profileAssignments = Object.entries(profilesByAgent);
	if (profileAssignments.length === 0) {
		throw new Error('Managed Hermes profilesByAgent must declare at least one profile.');
	}

	const configuredAgentIds = (zone.agents ?? []).map((agent) => agent.id);
	const configuredAgentIdSet = new Set(configuredAgentIds);
	if (configuredAgentIdSet.size !== configuredAgentIds.length) {
		throw new Error('Managed Hermes agents must not contain duplicate agent IDs.');
	}
	for (const configuredAgentId of configuredAgentIds) {
		if (!Object.hasOwn(profilesByAgent, configuredAgentId)) {
			throw new Error(
				`Managed Hermes profilesByAgent is missing configured agent '${configuredAgentId}'.`,
			);
		}
	}
	for (const [profileAgentId] of profileAssignments) {
		if (!configuredAgentIdSet.has(profileAgentId)) {
			throw new Error(
				`Managed Hermes profilesByAgent references undeclared agent '${profileAgentId}'.`,
			);
		}
	}

	const agentByNormalizedProfileName = new Map<string, string>();
	const profileNames: string[] = [];
	for (const [agentId, profileNameValue] of profileAssignments) {
		if (typeof profileNameValue !== 'string') {
			throw new Error(`Managed Hermes profile for agent '${agentId}' must be a string.`);
		}
		const normalizedProfileName = profileNameValue.trim().toLowerCase();
		const existingAgentId = agentByNormalizedProfileName.get(normalizedProfileName);
		if (existingAgentId !== undefined) {
			throw new Error(
				`Managed Hermes profile '${normalizedProfileName}' is assigned to multiple agents '${existingAgentId}' and '${agentId}'.`,
			);
		}
		agentByNormalizedProfileName.set(normalizedProfileName, agentId);
		if (
			profileNameValue !== normalizedProfileName ||
			!hermesProfileNamePattern.test(profileNameValue)
		) {
			throw new Error(
				`Managed Hermes profile '${profileNameValue}' must already be normalized and match [a-z0-9][a-z0-9_-]{0,63}.`,
			);
		}
		if (profileNameValue === 'default') {
			throw new Error("Managed Hermes profile 'default' is not admitted.");
		}
		profileNames.push(profileNameValue);
	}

	return Object.freeze(profileNames.toSorted());
}

function hermesProfilesDirectoryPath(zone: GatewayZoneConfig): string {
	return path.join(zone.gateway.stateDir, hermesProfilesDirectoryName);
}

function hermesRootConfigurationPath(zone: GatewayZoneConfig): string {
	return path.join(zone.gateway.stateDir, hermesRootConfigurationFileName);
}

function hermesProfileConfigurationPath(zone: GatewayZoneConfig, profileName: string): string {
	return path.join(hermesProfilesDirectoryPath(zone), profileName, hermesRootConfigurationFileName);
}

const forbiddenDurableArtifactPaths = [
	'.env',
	'.op.env',
	'gateway.json',
	'cache/op_cache.json',
	'cache/bws_cache.json',
	'cache/bws_cache.enc.json',
] as const;

async function validateHermesDurableArtifactsAbsent(options: {
	readonly durableHomePath: string;
	readonly homeLabel: string;
}): Promise<void> {
	for (const forbiddenRelativePath of forbiddenDurableArtifactPaths) {
		if (
			(await readPathStatus(path.join(options.durableHomePath, forbiddenRelativePath))) !==
			undefined
		) {
			throw new Error(
				`Managed Hermes durable ${options.homeLabel} artifact '${forbiddenRelativePath}' must be absent.`,
			);
		}
	}
}

async function validateHermesRootConfigurationFile(options: {
	readonly allowMissing: boolean;
	readonly configurationFilePath: string;
}): Promise<void> {
	const configurationFileStatus = await readPathStatus(options.configurationFilePath);
	if (configurationFileStatus === undefined) {
		if (options.allowMissing) {
			return;
		}
		throw new Error(`Managed Hermes root config '${options.configurationFilePath}' is missing.`);
	}
	if (configurationFileStatus.isSymbolicLink()) {
		throw new Error(
			`Managed Hermes root config '${options.configurationFilePath}' must not be a symbolic link.`,
		);
	}
	if (!configurationFileStatus.isFile()) {
		throw new Error(
			`Managed Hermes root config '${options.configurationFilePath}' must be a regular file.`,
		);
	}
}

async function ensureHermesRootConfigurationFile(zone: GatewayZoneConfig): Promise<void> {
	await ensureHermesConfigurationFile(hermesRootConfigurationPath(zone));
}

async function ensureHermesConfigurationFile(configurationFilePath: string): Promise<void> {
	try {
		await writeFile(configurationFilePath, '{}\n', {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o600,
		});
	} catch (error: unknown) {
		if (!isExistingPathError(error)) {
			throw error;
		}
	}
	await validateHermesRootConfigurationFile({
		allowMissing: false,
		configurationFilePath,
	});
}

async function validateExistingHermesConfigurationFile(
	configurationFilePath: string,
): Promise<void> {
	if ((await readPathStatus(configurationFilePath)) !== undefined) {
		await validateHermesNativeConfigurationFile(configurationFilePath);
	}
}

async function validateHermesProfileDirectoryTopology(options: {
	readonly allowMissingExpectedProfiles: boolean;
	readonly expectedProfileNames: readonly string[];
	readonly profilesDirectoryPath: string;
}): Promise<void> {
	const profilesDirectoryStatus = await readPathStatus(options.profilesDirectoryPath);
	if (profilesDirectoryStatus === undefined) {
		if (options.allowMissingExpectedProfiles) {
			return;
		}
		throw new Error(`Managed Hermes profiles root '${options.profilesDirectoryPath}' is missing.`);
	}
	if (profilesDirectoryStatus.isSymbolicLink()) {
		throw new Error(
			`Managed Hermes profiles root '${options.profilesDirectoryPath}' must not be a symbolic link.`,
		);
	}
	if (!profilesDirectoryStatus.isDirectory()) {
		throw new Error(
			`Managed Hermes profiles root '${options.profilesDirectoryPath}' must be a directory.`,
		);
	}

	const expectedProfileNameSet = new Set(options.expectedProfileNames);
	const profileEntries = (
		await readdir(options.profilesDirectoryPath, { withFileTypes: true })
	).toSorted((leftEntry, rightEntry) => leftEntry.name.localeCompare(rightEntry.name));
	for (const profileEntry of profileEntries) {
		if (!expectedProfileNameSet.has(profileEntry.name)) {
			throw new Error(
				`Managed Hermes profiles root contains unexpected profile entry '${profileEntry.name}'.`,
			);
		}
	}
	const existingProfileNames = await Promise.all(
		profileEntries.map(async (profileEntry): Promise<string> => {
			const profileDirectoryPath = path.join(options.profilesDirectoryPath, profileEntry.name);
			const profileDirectoryStatus = await lstat(profileDirectoryPath);
			if (profileDirectoryStatus.isSymbolicLink()) {
				throw new Error(
					`Managed Hermes profile '${profileEntry.name}' must not be a symbolic link.`,
				);
			}
			if (!profileDirectoryStatus.isDirectory()) {
				throw new Error(`Managed Hermes profile '${profileEntry.name}' must be a directory.`);
			}
			return profileEntry.name;
		}),
	);
	const existingProfileNameSet = new Set(existingProfileNames);

	if (!options.allowMissingExpectedProfiles) {
		for (const expectedProfileName of options.expectedProfileNames) {
			if (!existingProfileNameSet.has(expectedProfileName)) {
				throw new Error(`Managed Hermes profile '${expectedProfileName}' is missing.`);
			}
		}
	}
}

export async function preflightHermesProfileDirectories(
	zone: GatewayZoneConfig,
	_secretResolver: GatewayHostStateSecretResolver,
): Promise<void> {
	const expectedProfileNames = requireHermesProfileNames(zone);
	await loadHermesManagedConfiguration(zone.gateway.config);
	await validateHermesDurableArtifactsAbsent({
		durableHomePath: zone.gateway.stateDir,
		homeLabel: 'root',
	});
	await validateHermesRootConfigurationFile({
		allowMissing: true,
		configurationFilePath: hermesRootConfigurationPath(zone),
	});
	await validateHermesProfileDirectoryTopology({
		allowMissingExpectedProfiles: true,
		expectedProfileNames,
		profilesDirectoryPath: hermesProfilesDirectoryPath(zone),
	});
	await Promise.all(
		expectedProfileNames.map(
			async (profileName) =>
				await validateHermesDurableArtifactsAbsent({
					durableHomePath: path.join(hermesProfilesDirectoryPath(zone), profileName),
					homeLabel: `profile '${profileName}'`,
				}),
		),
	);
	await validateExistingHermesConfigurationFile(hermesRootConfigurationPath(zone));
	await Promise.all(
		expectedProfileNames.map(
			async (profileName) =>
				await validateExistingHermesConfigurationFile(
					hermesProfileConfigurationPath(zone, profileName),
				),
		),
	);
}

export async function prepareHermesProfileDirectories(
	zone: GatewayZoneConfig,
	_secretResolver: GatewayHostStateSecretResolver,
): Promise<void> {
	const expectedProfileNames = requireHermesProfileNames(zone);
	const profilesDirectoryPath = hermesProfilesDirectoryPath(zone);
	await loadHermesManagedConfiguration(zone.gateway.config);
	await validateHermesDurableArtifactsAbsent({
		durableHomePath: zone.gateway.stateDir,
		homeLabel: 'root',
	});
	await validateHermesRootConfigurationFile({
		allowMissing: true,
		configurationFilePath: hermesRootConfigurationPath(zone),
	});
	await validateHermesProfileDirectoryTopology({
		allowMissingExpectedProfiles: true,
		expectedProfileNames,
		profilesDirectoryPath,
	});
	await Promise.all(
		expectedProfileNames.map(
			async (profileName) =>
				await validateHermesDurableArtifactsAbsent({
					durableHomePath: path.join(profilesDirectoryPath, profileName),
					homeLabel: `profile '${profileName}'`,
				}),
		),
	);
	await ensureHermesRootConfigurationFile(zone);

	if ((await readPathStatus(profilesDirectoryPath)) === undefined) {
		await mkdir(profilesDirectoryPath, { mode: 0o700 });
	}
	await Promise.all(
		expectedProfileNames.map(async (expectedProfileName): Promise<void> => {
			const profileDirectoryPath = path.join(profilesDirectoryPath, expectedProfileName);
			if ((await readPathStatus(profileDirectoryPath)) === undefined) {
				await mkdir(profileDirectoryPath, { mode: 0o700 });
			}
		}),
	);
	await Promise.all(
		expectedProfileNames.map(
			async (profileName) =>
				await ensureHermesConfigurationFile(hermesProfileConfigurationPath(zone, profileName)),
		),
	);

	await validateHermesProfileDirectoryTopology({
		allowMissingExpectedProfiles: false,
		expectedProfileNames,
		profilesDirectoryPath,
	});
	await validateHermesNativeConfigurationFile(hermesRootConfigurationPath(zone));
	await Promise.all(
		expectedProfileNames.map(
			async (profileName) =>
				await validateHermesNativeConfigurationFile(
					hermesProfileConfigurationPath(zone, profileName),
				),
		),
	);
}
