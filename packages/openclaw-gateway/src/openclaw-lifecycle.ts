import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmRequirementsOptions,
	BuildManagedFrameworkServiceBootInputsOptions,
	GatewayZoneConfig,
	GatewayVmRequirements,
	ManagedFrameworkServiceBootInputs,
	ManagedGatewayLifecycle,
	ManagedOpenClawServiceBootMetadata,
	SplitResolvedGatewaySecretsResult,
} from '@agent-vm/gateway-lifecycle';
import {
	buildGatewaySessionLabel as buildGatewaySessionLabelValue,
	composeNodeOptions,
	GATEWAY_CONTROL_PRIVATE_ENVIRONMENT_NAMES,
	gatewayVmAllowedHosts,
	mergeRuntimeGatewaySecrets,
	normalizeGitReposForSshReadAllowlist,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-lifecycle';
import type { ManagedVmGitReadOnlySshEgress } from '@agent-vm/managed-vm';
import {
	redactOnePasswordReferences,
	type SecretRef,
	type SecretResolver,
} from '@agent-vm/secret-management';

import { writeFileAtomically } from './write-file-atomically.js';

const effectiveOpenClawConfigFileName = 'effective-openclaw.json';
const effectiveOpenClawConfigVmPath = `/home/openclaw/.openclaw/state/${effectiveOpenClawConfigFileName}`;
const openClawStateDirVmPath = '/home/openclaw/.openclaw/state';
const openClawCacheDirVmPath = '/home/openclaw/.openclaw/cache';
const openClawZoneFilesDirVmPath = '/zone';
const agentVmLogsDirVmPath = '/agent-vm/logs';
const openClawRuntimeLogFileVmPath = `${agentVmLogsDirVmPath}/openclaw-YYYY-MM-DD.log`;
const openClawGatewayGuestPort = 18789;
const managedFrameworkConfigurationInputPath =
	'/run/agent-vm/managed-gateway/framework-service.json';
const managedFrameworkEnvironmentInputPath =
	'/run/agent-vm/managed-gateway/framework.environment.sh';
const openClawGatewayGuestPath =
	'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const diagnosticsOtelPluginId = 'diagnostics-otel';
const diagnosticsOtelPackageName = '@openclaw/diagnostics-otel';
const diagnosticsOtelGlobalPackageVmPath = '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel';
const otelResourceAttributesEnvironmentVariable = 'OTEL_RESOURCE_ATTRIBUTES';
const deprecatedMcpPortalPluginId = 'mcp-portal';
const openClawInstalledPluginDirectoryName = 'plugins';
const openClawInstalledPluginIndexFileName = 'installs.json';
const gondolinPluginConfigFields = new Set(['toolPortal', 'zoneId']);
const gondolinToolPortalConfigFields = new Set(['agentProjections', 'attachment']);
const gondolinToolPortalAgentProjectionFields = new Set([
	'agentId',
	'frameworkIdentity',
	'profileAssignmentRevision',
	'toolPortalProfileId',
]);
const gondolinToolPortalAttachmentFields = new Set([
	'attachmentGeneration',
	'clientKind',
	'configuredAgentIds',
	'frameworkEpoch',
	'gatewayEpoch',
	'protocolVersion',
	'projectionCohortDigest',
	'runtimeEpoch',
	'schemaVersion',
]);
const maximumGondolinConfiguredAgents = 128;
const maximumGondolinOpaqueIdentifierCharacters = 256;

interface OpenClawSecretRef {
	readonly id: string;
	readonly provider: string;
	readonly source: 'env';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setTcpHost(tcpHosts: Record<string, string>, key: string, target: string): void {
	const existingTarget = tcpHosts[key];
	if (existingTarget !== undefined && existingTarget !== target) {
		throw new Error(
			`OpenClaw tcpHosts entry '${key}' cannot target both '${existingTarget}' and '${target}'.`,
		);
	}
	tcpHosts[key] = target;
}

function buildGatewayTcpHosts(tcpPool: {
	readonly basePort: number;
	readonly size: number;
}): Record<string, string> {
	const tcpHosts: Record<string, string> = {};

	for (let slot = 0; slot < tcpPool.size; slot += 1) {
		setTcpHost(tcpHosts, `tool-${slot}.vm.host:22`, `127.0.0.1:${tcpPool.basePort + slot}`);
	}

	return tcpHosts;
}

function mergeGatewayAllowedHosts(
	egressHosts: GatewayZoneConfig['egressHosts'],
	observability: GatewayZoneConfig['observability'],
): readonly string[] {
	const allowedHosts = [...gatewayVmAllowedHosts(egressHosts)];
	if (observability?.mode === 'collector' && !allowedHosts.includes(observability.collector.host)) {
		allowedHosts.push(observability.collector.host);
	}
	return allowedHosts;
}

function createManagedGitReadOnlySshEgressOptions(options: {
	readonly gitReadAllowlistRepos: readonly string[] | undefined;
}): ManagedVmGitReadOnlySshEgress | undefined {
	const agent = process.env.SSH_AUTH_SOCK;
	if (agent === undefined || agent.length === 0) {
		return undefined;
	}
	const normalizedAllowlist = normalizeGitReposForSshReadAllowlist(options.gitReadAllowlistRepos);
	if (
		normalizedAllowlist.allowedHosts.length === 0 ||
		normalizedAllowlist.allowedRepos.length === 0
	) {
		return undefined;
	}
	return {
		agentSocket: agent,
		allowedHosts: normalizedAllowlist.allowedHosts,
		allowedRepositories: normalizedAllowlist.allowedRepos,
		kind: 'git-read-only',
	};
}

function getEffectiveOpenClawConfigHostPath(zone: GatewayZoneConfig): string {
	return path.join(zone.gateway.stateDir, effectiveOpenClawConfigFileName);
}

function getOpenClawInstalledPluginIndexHostPath(zone: GatewayZoneConfig): string {
	return path.join(
		zone.gateway.stateDir,
		openClawInstalledPluginDirectoryName,
		openClawInstalledPluginIndexFileName,
	);
}

async function lstatIfExists(
	filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	return await lstat(filePath).catch((error: unknown) => {
		if (isObjectRecord(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	});
}

async function assertOpenClawPluginIndexPathSafe(zone: GatewayZoneConfig): Promise<void> {
	const indexPath = getOpenClawInstalledPluginIndexHostPath(zone);
	const pluginsDirectory = path.dirname(indexPath);
	const existingPluginsDirectory = await lstatIfExists(pluginsDirectory);
	if (existingPluginsDirectory?.isSymbolicLink()) {
		throw new Error(`OpenClaw plugin registry directory '${pluginsDirectory}' is a symlink.`);
	}
	if (existingPluginsDirectory !== undefined && !existingPluginsDirectory.isDirectory()) {
		throw new Error(`OpenClaw plugin registry directory '${pluginsDirectory}' is not a directory.`);
	}

	await mkdir(pluginsDirectory, { recursive: true, mode: 0o700 });
	const preparedPluginsDirectory = await lstat(pluginsDirectory);
	if (preparedPluginsDirectory.isSymbolicLink()) {
		throw new Error(`OpenClaw plugin registry directory '${pluginsDirectory}' is a symlink.`);
	}
	if (!preparedPluginsDirectory.isDirectory()) {
		throw new Error(`OpenClaw plugin registry directory '${pluginsDirectory}' is not a directory.`);
	}
	await chmod(pluginsDirectory, 0o700);

	const existingIndex = await lstatIfExists(indexPath);
	if (existingIndex?.isSymbolicLink()) {
		throw new Error(`OpenClaw plugin registry index '${indexPath}' is a symlink.`);
	}
	if (existingIndex?.isDirectory()) {
		throw new Error(`OpenClaw plugin registry index '${indexPath}' is a directory.`);
	}
	if (existingIndex !== undefined && !existingIndex.isFile()) {
		throw new Error(`OpenClaw plugin registry index '${indexPath}' is not a regular file.`);
	}
}

async function buildOpenClawInstalledPluginIndexContent(zone: GatewayZoneConfig): Promise<string> {
	const indexPath = getOpenClawInstalledPluginIndexHostPath(zone);
	const existingContent = await readFile(indexPath, 'utf8').catch((error: unknown) => {
		if (isObjectRecord(error) && error.code === 'ENOENT') {
			return '{}';
		}
		throw error;
	});
	const trimmedContent = existingContent.trim();
	const parsedContent: unknown = trimmedContent.length === 0 ? {} : JSON.parse(trimmedContent);
	if (!isObjectRecord(parsedContent)) {
		throw new Error(`OpenClaw plugin registry index '${indexPath}' must be a JSON object.`);
	}
	const existingInstallRecords = isObjectRecord(parsedContent.installRecords)
		? parsedContent.installRecords
		: {};
	const installIndex = {
		...parsedContent,
		installRecords: {
			...existingInstallRecords,
			[diagnosticsOtelPluginId]: buildDiagnosticsOtelManagedInstallRecord(),
		},
	};
	return `${JSON.stringify(installIndex, null, 2)}\n`;
}

async function writeManagedDiagnosticsOtelInstallRecord(zone: GatewayZoneConfig): Promise<void> {
	if (zone.observability?.mode !== 'collector') {
		return;
	}
	try {
		await assertOpenClawPluginIndexPathSafe(zone);
		const indexPath = getOpenClawInstalledPluginIndexHostPath(zone);
		const content = await buildOpenClawInstalledPluginIndexContent(zone);
		await writeFileAtomically(indexPath, content, { mode: 0o600 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to write managed OpenClaw diagnostics plugin registry record for zone '${zone.id}': ${message}`,
			{ cause: error },
		);
	}
}

async function preflightManagedDiagnosticsOtelInstallRecord(
	zone: GatewayZoneConfig,
): Promise<void> {
	if (zone.observability?.mode !== 'collector') {
		return;
	}
	try {
		await assertOpenClawPluginIndexPathSafe(zone);
		await buildOpenClawInstalledPluginIndexContent(zone);
		const indexPath = getOpenClawInstalledPluginIndexHostPath(zone);
		const preflightPath = path.join(
			path.dirname(indexPath),
			`.agent-vm-openclaw-plugin-registry-preflight-${process.pid}-${randomUUID()}.json`,
		);
		try {
			await writeFileAtomically(preflightPath, '{}\n', { mode: 0o600 });
		} finally {
			await rm(preflightPath, { force: true });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to preflight managed OpenClaw diagnostics plugin registry record for zone '${zone.id}': ${message}`,
			{ cause: error },
		);
	}
}

async function assertEffectiveConfigPathWritable(
	zone: GatewayZoneConfig,
	content: string,
): Promise<void> {
	const effectiveConfigPath = getEffectiveOpenClawConfigHostPath(zone);
	const existingEffectiveConfig = await lstat(effectiveConfigPath).catch((error: unknown) => {
		if (isObjectRecord(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	});
	if (existingEffectiveConfig?.isDirectory()) {
		throw new Error(`Effective OpenClaw config path '${effectiveConfigPath}' is a directory.`);
	}

	const preflightPath = path.join(
		zone.gateway.stateDir,
		`.agent-vm-effective-openclaw-preflight-${process.pid}-${randomUUID()}.json`,
	);
	try {
		await writeFileAtomically(preflightPath, content, { mode: 0o600 });
	} finally {
		await rm(preflightPath, { force: true });
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function assertAllowedOpenClawEnvironmentSecrets(
	zone: GatewayZoneConfig,
	environmentSecrets: Readonly<Record<string, string>>,
	logPrefix: string,
): void {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	const allowedRawEnvSecrets = new Set([
		zone.gateway.controlAuth.secret,
		...(zone.gateway.rawEnvSecrets ?? []),
	]);
	for (const secretName of Object.keys(environmentSecrets)) {
		if (zone.observability?.mode === 'collector' && secretName === 'OPENCLAW_DIAGNOSTICS') {
			throw new Error(
				`[${logPrefix}] OpenClaw observability owns diagnostics configuration; do not inject OPENCLAW_DIAGNOSTICS through gateway raw environment secrets.`,
			);
		}
		if (
			zone.observability?.mode === 'collector' &&
			secretName === otelResourceAttributesEnvironmentVariable
		) {
			continue;
		}
		if (allowedRawEnvSecrets.has(secretName)) {
			continue;
		}
		throw new Error(
			`[${logPrefix}] OpenClaw env secret '${secretName}' must be listed in gateway.rawEnvSecrets or use injection 'http-mediation'.`,
		);
	}
}

function assertNoOpenClawPrivateEnvironmentCollisions(options: {
	readonly environmentSecrets: Readonly<Record<string, string>>;
	readonly runtimeEnvironment: Readonly<Record<string, string>> | undefined;
	readonly runtimePrivateEnvironment: GatewayZoneConfig['runtimePrivateEnvironment'] | undefined;
}): void {
	const privateEnvironmentNames = new Set<string>(GATEWAY_CONTROL_PRIVATE_ENVIRONMENT_NAMES);
	for (const secretName of Object.keys(options.environmentSecrets)) {
		if (privateEnvironmentNames.has(secretName)) {
			throw new Error(
				`OpenClaw runtime environment secret '${secretName}' collides with a controller-owned private environment variable.`,
			);
		}
	}
	for (const environmentName of Object.keys(options.runtimeEnvironment ?? {})) {
		if (privateEnvironmentNames.has(environmentName)) {
			throw new Error(
				`OpenClaw runtime environment '${environmentName}' collides with a controller-owned private environment variable.`,
			);
		}
	}
	for (const environmentName of Object.keys(options.runtimePrivateEnvironment ?? {})) {
		if (!privateEnvironmentNames.has(environmentName)) {
			throw new Error(
				`OpenClaw private environment variable '${environmentName}' is not a registered controller-owned private environment variable.`,
			);
		}
	}
}

function splitAllowedOpenClawGatewaySecrets(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
	logPrefix: string,
): SplitResolvedGatewaySecretsResult {
	const splitSecrets = splitResolvedGatewaySecrets(zone, resolvedSecrets);
	assertAllowedOpenClawEnvironmentSecrets(zone, splitSecrets.environmentSecrets, logPrefix);
	return splitSecrets;
}

type SourceAwareSecretReference =
	| {
			readonly source: 'environment';
			readonly envVar: string;
	  }
	| {
			readonly source: '1password';
			readonly ref: string;
	  }
	| {
			readonly source: 'config';
			readonly value: string;
	  };

function isSourceAwareSecretReference(value: unknown): value is SourceAwareSecretReference {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	if (!('source' in value) || typeof value.source !== 'string') {
		return false;
	}

	if (value.source === 'environment') {
		return 'envVar' in value && typeof value.envVar === 'string';
	}

	if (value.source === '1password') {
		return 'ref' in value && typeof value.ref === 'string';
	}

	if (value.source === 'config') {
		return 'value' in value && typeof value.value === 'string';
	}

	return false;
}

function toSecretRef(secret: SourceAwareSecretReference): SecretRef {
	switch (secret.source) {
		case 'environment':
			return {
				source: 'environment',
				ref: secret.envVar,
			};
		case '1password':
			return {
				source: '1password',
				ref: secret.ref,
			};
		case 'config':
			return {
				source: 'config',
				value: secret.value,
			};
		default: {
			const exhaustiveCheck: never = secret;
			throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
}

function describeSecretReference(secret: SourceAwareSecretReference): string {
	switch (secret.source) {
		case 'environment':
			return secret.envVar;
		case '1password':
			return redactOnePasswordReferences(secret.ref);
		case 'config':
			return 'config value';
		default: {
			const exhaustiveCheck: never = secret;
			throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
}

function formatSafeOpenClawErrorMessage(error: unknown): string {
	return redactOnePasswordReferences(error instanceof Error ? error.message : String(error));
}

function buildEffectiveSecretsConfig(
	parsedBaseConfig: Record<string, unknown>,
): Record<string, unknown> {
	const existingSecretsConfig = isObjectRecord(parsedBaseConfig.secrets)
		? parsedBaseConfig.secrets
		: {};
	const existingProvidersConfig = isObjectRecord(existingSecretsConfig.providers)
		? existingSecretsConfig.providers
		: {};

	return {
		...existingSecretsConfig,
		providers: {
			...existingProvidersConfig,
			default: {
				source: 'env',
			},
		},
	};
}

function appendUniqueStrings(
	existingValues: readonly string[],
	additionalValues: readonly string[],
): readonly string[] {
	const values = [...existingValues];
	for (const value of additionalValues) {
		if (!values.includes(value)) {
			values.push(value);
		}
	}
	return values;
}

function buildDiagnosticsOtelManagedInstallRecord(): Record<string, unknown> {
	return {
		source: 'npm',
		spec: diagnosticsOtelPackageName,
		installPath: diagnosticsOtelGlobalPackageVmPath,
	};
}

function omitPluginConfigEntry(
	config: Record<string, unknown>,
	pluginId: string,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(config).filter(([key]) => key !== pluginId));
}

function assertNoRemovedGondolinAuthorityConfig(config: Readonly<Record<string, unknown>>): void {
	if (Object.hasOwn(config, 'controllerUrl')) {
		throw new Error('Gondolin plugin config no longer accepts controllerUrl.');
	}
	if (Object.hasOwn(config, 'zoneGitToken') || Object.hasOwn(config, 'zoneGitTokenEnv')) {
		throw new Error('Gondolin plugin config no longer accepts zone git token fields.');
	}
}

function assertNoUnknownGondolinConfigFields(options: {
	readonly allowedFields: ReadonlySet<string>;
	readonly label: string;
	readonly record: Readonly<Record<string, unknown>>;
}): void {
	for (const fieldName of Object.keys(options.record)) {
		if (!options.allowedFields.has(fieldName)) {
			throw new Error(`Gondolin plugin ${options.label} does not accept field '${fieldName}'.`);
		}
	}
}

function assertOptionalGondolinStringField(options: {
	readonly fieldName: string;
	readonly label: string;
	readonly record: Readonly<Record<string, unknown>>;
}): void {
	if (!Object.hasOwn(options.record, options.fieldName)) {
		return;
	}
	const fieldValue = options.record[options.fieldName];
	if (typeof fieldValue !== 'string') {
		throw new Error(`Gondolin plugin ${options.label} requires string ${options.fieldName}.`);
	}
	if (fieldValue.trim() === '') {
		throw new Error(`Gondolin plugin ${options.label} requires non-empty ${options.fieldName}.`);
	}
}

function requireGondolinStringField(options: {
	readonly fieldName: string;
	readonly label: string;
	readonly record: Readonly<Record<string, unknown>>;
}): string {
	const fieldValue = options.record[options.fieldName];
	if (typeof fieldValue !== 'string') {
		throw new Error(`Gondolin plugin ${options.label} requires string ${options.fieldName}.`);
	}
	if (fieldValue.trim() === '') {
		throw new Error(`Gondolin plugin ${options.label} requires non-empty ${options.fieldName}.`);
	}
	return fieldValue;
}

function assertOptionalManagedGondolinObjectField(options: {
	readonly config: Readonly<Record<string, unknown>>;
	readonly fieldName: 'toolPortal';
}): Readonly<Record<string, unknown>> | undefined {
	if (!Object.hasOwn(options.config, options.fieldName)) {
		return undefined;
	}
	const rawFieldValue = options.config[options.fieldName];
	if (!isObjectRecord(rawFieldValue)) {
		throw new Error(`Gondolin plugin ${options.fieldName} must be an object when present.`);
	}
	return rawFieldValue;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBoundedOpaqueIdentifier(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximumGondolinOpaqueIdentifierCharacters
	);
}

function isManagedOpenClawAttachmentMetadata(value: unknown): value is Readonly<{
	readonly configuredAgentIds: readonly string[];
}> {
	if (!isObjectRecord(value)) {
		return false;
	}
	if (Object.keys(value).some((fieldName) => !gondolinToolPortalAttachmentFields.has(fieldName))) {
		return false;
	}
	if (
		!isPositiveSafeInteger(value.attachmentGeneration) ||
		value.clientKind !== 'openclaw-managed-plugin' ||
		!isBoundedOpaqueIdentifier(value.frameworkEpoch) ||
		!isBoundedOpaqueIdentifier(value.gatewayEpoch) ||
		!isPositiveSafeInteger(value.protocolVersion) ||
		typeof value.projectionCohortDigest !== 'string' ||
		!/^projection-cohort:[a-f0-9]{64}$/u.test(value.projectionCohortDigest) ||
		!isBoundedOpaqueIdentifier(value.runtimeEpoch) ||
		!isPositiveSafeInteger(value.schemaVersion)
	) {
		return false;
	}
	if (
		!Array.isArray(value.configuredAgentIds) ||
		value.configuredAgentIds.length === 0 ||
		value.configuredAgentIds.length > maximumGondolinConfiguredAgents ||
		!value.configuredAgentIds.every(isBoundedOpaqueIdentifier)
	) {
		return false;
	}
	return new Set(value.configuredAgentIds).size === value.configuredAgentIds.length;
}

function assertManagedGondolinToolPortalConfig(
	toolPortalConfig: Readonly<Record<string, unknown>>,
): void {
	assertNoUnknownGondolinConfigFields({
		allowedFields: gondolinToolPortalConfigFields,
		label: 'toolPortal',
		record: toolPortalConfig,
	});
	if (!Object.hasOwn(toolPortalConfig, 'attachment')) {
		throw new Error('Gondolin plugin toolPortal requires attachment.');
	}
	if (!isManagedOpenClawAttachmentMetadata(toolPortalConfig.attachment)) {
		throw new Error('Gondolin plugin toolPortal attachment is invalid.');
	}
	const agentProjections = toolPortalConfig.agentProjections;
	if (!isObjectRecord(agentProjections)) {
		throw new Error('Gondolin plugin toolPortal requires agentProjections.');
	}
	const agentProjectionEntries = Object.entries(agentProjections);
	for (const [agentId, projection] of agentProjectionEntries) {
		if (!isBoundedOpaqueIdentifier(agentId)) {
			throw new Error('Gondolin plugin toolPortal agentProjections requires non-empty agent ids.');
		}
		if (!isObjectRecord(projection)) {
			throw new Error(
				`Gondolin plugin toolPortal agentProjections requires an object for agent '${agentId}'.`,
			);
		}
		const projectionLabel = `toolPortal agentProjections['${agentId}']`;
		assertNoUnknownGondolinConfigFields({
			allowedFields: gondolinToolPortalAgentProjectionFields,
			label: projectionLabel,
			record: projection,
		});
		for (const fieldName of [
			'agentId',
			'profileAssignmentRevision',
			'toolPortalProfileId',
		] as const) {
			requireGondolinStringField({
				fieldName,
				label: projectionLabel,
				record: projection,
			});
		}
		if (
			projection.agentId !== agentId ||
			!isBoundedOpaqueIdentifier(projection.profileAssignmentRevision) ||
			!isBoundedOpaqueIdentifier(projection.toolPortalProfileId) ||
			!isObjectRecord(projection.frameworkIdentity) ||
			projection.frameworkIdentity.kind !== 'openclaw' ||
			projection.frameworkIdentity.agentId !== agentId ||
			Object.keys(projection.frameworkIdentity).some(
				(fieldName) => fieldName !== 'agentId' && fieldName !== 'kind',
			)
		) {
			throw new Error(
				`Gondolin plugin toolPortal agentProjections identity is invalid for agent '${agentId}'.`,
			);
		}
	}
	const configuredAgentIds = [...toolPortalConfig.attachment.configuredAgentIds].toSorted();
	const projectionAgentIds = agentProjectionEntries.map(([agentId]) => agentId).toSorted();
	if (
		configuredAgentIds.length !== projectionAgentIds.length ||
		configuredAgentIds.some((agentId, index) => projectionAgentIds[index] !== agentId)
	) {
		throw new Error('Gondolin plugin toolPortal agent sets must match exactly.');
	}
}

function assertManagedGondolinPluginConfig(options: {
	readonly config: Readonly<Record<string, unknown>>;
	readonly requireZoneId?: boolean;
}): void {
	const config = options.config;
	assertNoRemovedGondolinAuthorityConfig(config);
	assertNoUnknownGondolinConfigFields({
		allowedFields: gondolinPluginConfigFields,
		label: 'config',
		record: config,
	});
	if (options.requireZoneId === true) {
		requireGondolinStringField({ fieldName: 'zoneId', label: 'config', record: config });
	} else {
		assertOptionalGondolinStringField({ fieldName: 'zoneId', label: 'config', record: config });
	}
	const toolPortalConfig = assertOptionalManagedGondolinObjectField({
		config,
		fieldName: 'toolPortal',
	});
	if (toolPortalConfig !== undefined) {
		assertManagedGondolinToolPortalConfig(toolPortalConfig);
	}
}

function isDeprecatedMcpPortalLoadPath(value: string): boolean {
	const normalizedValue = value.replace(/\/+$/u, '');
	return path.posix.basename(normalizedValue) === deprecatedMcpPortalPluginId;
}

function stripDeprecatedMcpPortalLoadConfig(loadConfig: unknown): unknown {
	if (!isObjectRecord(loadConfig)) {
		return loadConfig;
	}
	const paths = Array.isArray(loadConfig.paths)
		? loadConfig.paths.filter(
				(value): value is string =>
					typeof value === 'string' && !isDeprecatedMcpPortalLoadPath(value),
			)
		: undefined;
	return {
		...loadConfig,
		...(paths === undefined ? {} : { paths }),
	};
}

function stripDeprecatedMcpPortalPluginConfig(
	pluginsConfig: Record<string, unknown>,
): Record<string, unknown> {
	const allow = Array.isArray(pluginsConfig.allow)
		? pluginsConfig.allow.filter(
				(value): value is string =>
					typeof value === 'string' && value !== deprecatedMcpPortalPluginId,
			)
		: undefined;
	const entries = isObjectRecord(pluginsConfig.entries)
		? omitPluginConfigEntry(pluginsConfig.entries, deprecatedMcpPortalPluginId)
		: undefined;
	const installs = isObjectRecord(pluginsConfig.installs)
		? omitPluginConfigEntry(pluginsConfig.installs, deprecatedMcpPortalPluginId)
		: undefined;
	const load = stripDeprecatedMcpPortalLoadConfig(pluginsConfig.load);
	return {
		...pluginsConfig,
		...(allow === undefined ? {} : { allow }),
		...(entries === undefined ? {} : { entries }),
		...(installs === undefined ? {} : { installs }),
		...(load === undefined ? {} : { load }),
	};
}

function buildEffectivePluginsConfig(
	parsedBaseConfig: Record<string, unknown>,
	runtimePluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
	options: { readonly includeManagedDiagnosticsOtelInstall: boolean },
): Record<string, unknown> {
	const existingPluginsConfig = isObjectRecord(parsedBaseConfig.plugins)
		? stripDeprecatedMcpPortalPluginConfig(parsedBaseConfig.plugins)
		: {};
	const runtimePluginIds = Object.keys(runtimePluginConfigs ?? {});
	if (runtimePluginIds.includes(deprecatedMcpPortalPluginId)) {
		throw new Error(
			'managed OpenClaw does not accept runtime mcp-portal plugin config; use Tool Portal through the managed gondolin plugin',
		);
	}
	const existingAllowConfig = Array.isArray(existingPluginsConfig.allow)
		? existingPluginsConfig.allow.filter((value): value is string => typeof value === 'string')
		: [];
	const existingEntriesConfig = isObjectRecord(existingPluginsConfig.entries)
		? existingPluginsConfig.entries
		: {};
	const existingInstallsConfig = isObjectRecord(existingPluginsConfig.installs)
		? existingPluginsConfig.installs
		: {};
	const runtimeEntriesConfig: Record<string, unknown> = {};
	for (const [pluginId, runtimeConfig] of Object.entries(runtimePluginConfigs ?? {})) {
		const rawExistingEntryConfig = existingEntriesConfig[pluginId];
		if (pluginId === 'gondolin' && Object.hasOwn(existingEntriesConfig, pluginId)) {
			if (!isObjectRecord(rawExistingEntryConfig)) {
				throw new Error('Gondolin plugin entry must be an object when present.');
			}
			if (
				Object.hasOwn(rawExistingEntryConfig, 'config') &&
				!isObjectRecord(rawExistingEntryConfig.config)
			) {
				throw new Error('Gondolin plugin config must be an object when present.');
			}
		}
		const existingEntryConfig = isObjectRecord(rawExistingEntryConfig)
			? rawExistingEntryConfig
			: {};
		if (pluginId === diagnosticsOtelPluginId) {
			runtimeEntriesConfig[pluginId] = {
				enabled: true,
			};
			continue;
		}
		const existingPluginConfig = isObjectRecord(existingEntryConfig.config)
			? existingEntryConfig.config
			: {};
		if (pluginId === 'gondolin') {
			assertManagedGondolinPluginConfig({ config: existingPluginConfig });
			assertManagedGondolinPluginConfig({ config: runtimeConfig });
		}
		const config = {
			...existingPluginConfig,
			...runtimeConfig,
		};
		if (pluginId === 'gondolin') {
			assertManagedGondolinPluginConfig({
				config,
				requireZoneId: true,
			});
		}
		runtimeEntriesConfig[pluginId] = {
			...existingEntryConfig,
			config,
		};
	}

	return {
		...existingPluginsConfig,
		...(runtimePluginIds.length > 0
			? { allow: appendUniqueStrings(existingAllowConfig, runtimePluginIds) }
			: {}),
		...(options.includeManagedDiagnosticsOtelInstall
			? {
					installs: {
						...existingInstallsConfig,
						[diagnosticsOtelPluginId]: buildDiagnosticsOtelManagedInstallRecord(),
					},
				}
			: {}),
		entries: {
			...existingEntriesConfig,
			...runtimeEntriesConfig,
		},
	};
}

function buildEffectiveMcpConfig(
	parsedBaseConfig: Record<string, unknown>,
	runtimeMcpServers: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const existingMcpConfig = isObjectRecord(parsedBaseConfig.mcp) ? parsedBaseConfig.mcp : {};
	const existingServersConfig = isObjectRecord(existingMcpConfig.servers)
		? existingMcpConfig.servers
		: {};
	return {
		...existingMcpConfig,
		servers: {
			...existingServersConfig,
			...runtimeMcpServers,
		},
	};
}

function buildEffectiveLoggingConfig(
	parsedBaseConfig: Record<string, unknown>,
): Record<string, unknown> {
	const existingLoggingConfig = isObjectRecord(parsedBaseConfig.logging)
		? parsedBaseConfig.logging
		: {};

	return {
		file: openClawRuntimeLogFileVmPath,
		...existingLoggingConfig,
	};
}

function assertObservabilityCompatibleLoggingConfig(
	parsedBaseConfig: Record<string, unknown>,
): void {
	const existingLoggingConfig = isObjectRecord(parsedBaseConfig.logging)
		? parsedBaseConfig.logging
		: {};
	const redactSensitiveValue = existingLoggingConfig.redactSensitive;
	if (isDisabledOpenClawRedactionValue(redactSensitiveValue)) {
		throw new Error(
			"OpenClaw observability requires logging.redactSensitive to stay enabled; remove 'off' or false before enabling telemetry.",
		);
	}
}

function isDisabledOpenClawRedactionValue(value: unknown): boolean {
	if (value === false || value === 0) {
		return true;
	}
	if (typeof value !== 'string') {
		return false;
	}
	return ['0', 'disable', 'disabled', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function buildEffectiveDiagnosticsConfig(
	parsedBaseConfig: Record<string, unknown>,
	zone: GatewayZoneConfig,
): Record<string, unknown> | undefined {
	if (zone.observability?.mode !== 'collector') {
		return undefined;
	}

	const existingDiagnosticsConfig = isObjectRecord(parsedBaseConfig.diagnostics)
		? parsedBaseConfig.diagnostics
		: {};
	const { collector, framework } = zone.observability;
	return {
		...existingDiagnosticsConfig,
		enabled: true,
		flags: zone.observability.openclaw?.diagnosticsFlags ?? [],
		otel: {
			captureContent: { enabled: framework.sourcePolicy.captureContent },
			enabled: true,
			endpoint: `http://${collector.host}:${String(collector.httpPort)}`,
			flushIntervalMs: framework.flushIntervalMs,
			logs: framework.logs,
			metrics: framework.metrics,
			protocol: 'http/protobuf',
			sampleRate: framework.sampleRate,
			serviceName: framework.serviceName,
			traces: framework.traces,
		},
	};
}

async function writeAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
	const resolvedAuthProfiles = await resolveAuthProfilesIfConfigured(zone, secretResolver);

	const writeResults = await Promise.allSettled(
		resolvedAuthProfiles.map(async ({ agentId, authProfiles }) => {
			const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', agentId, 'agent');
			await mkdir(authProfilesDirectory, { recursive: true, mode: 0o700 });
			await chmod(authProfilesDirectory, 0o700);
			await writeFileAtomically(
				path.join(authProfilesDirectory, 'auth-profiles.json'),
				authProfiles,
				{
					mode: 0o600,
				},
			);
		}),
	);
	const writeErrors = writeResults
		.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
		.map((result) =>
			result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
		);
	if (writeErrors.length > 0) {
		throw new AggregateError(
			writeErrors,
			`Failed to write ${String(writeErrors.length)} OpenClaw auth profile file(s) for zone '${zone.id}'.`,
		);
	}
}

async function assertAuthProfilePathWritable(
	zone: GatewayZoneConfig,
	agentId: string,
): Promise<void> {
	const authProfilesDirectory = path.join(zone.gateway.stateDir, 'agents', agentId, 'agent');
	const authProfilesPath = path.join(authProfilesDirectory, 'auth-profiles.json');
	const existingAuthProfilesPath = await lstat(authProfilesPath).catch((error: unknown) => {
		if (isObjectRecord(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	});
	if (existingAuthProfilesPath?.isDirectory()) {
		throw new Error(`OpenClaw auth profiles path '${authProfilesPath}' is a directory.`);
	}

	const preflightPath = path.join(
		authProfilesDirectory,
		`.agent-vm-auth-profiles-preflight-${process.pid}-${randomUUID()}.json`,
	);
	try {
		await mkdir(authProfilesDirectory, { recursive: true, mode: 0o700 });
		await chmod(authProfilesDirectory, 0o700);
		await writeFileAtomically(preflightPath, '{}\n', { mode: 0o600 });
	} finally {
		await rm(preflightPath, { force: true });
	}
}

async function preflightAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<void> {
	const resolvedAuthProfiles = await resolveAuthProfilesIfConfigured(zone, secretResolver);
	const writeResults = await Promise.allSettled(
		resolvedAuthProfiles.map(async ({ agentId }) => {
			await assertAuthProfilePathWritable(zone, agentId);
		}),
	);
	const writeErrors = writeResults
		.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
		.map((result) =>
			result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
		);
	if (writeErrors.length > 0) {
		throw new AggregateError(
			writeErrors,
			`Failed to preflight ${String(writeErrors.length)} OpenClaw auth profile file write(s) for zone '${zone.id}'.`,
		);
	}
}

async function resolveAuthProfilesIfConfigured(
	zone: GatewayZoneConfig,
	secretResolver: SecretResolver,
): Promise<readonly { readonly agentId: string; readonly authProfiles: string }[]> {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot prepare gateway type '${zone.gateway.type}'.`);
	}
	const authProfilesByAgent = {
		...(zone.gateway.authProfilesRef ? { main: zone.gateway.authProfilesRef } : {}),
		...zone.gateway.authProfilesByAgent,
	};

	const resolveResults = await Promise.allSettled(
		Object.entries(authProfilesByAgent).map(async ([agentId, authProfilesSecretCandidate]) => {
			if (!isSourceAwareSecretReference(authProfilesSecretCandidate)) {
				throw new Error(
					`Zone '${zone.id}' has an invalid auth profile shape for agent '${agentId}'.`,
				);
			}
			const authProfilesSecret = authProfilesSecretCandidate;

			try {
				const authProfiles = await secretResolver.resolve(toSecretRef(authProfilesSecret));
				return { agentId, authProfiles };
			} catch (error) {
				const message = formatSafeOpenClawErrorMessage(error);
				throw new Error(
					`Failed to resolve OpenClaw auth profiles for zone '${zone.id}' agent '${agentId}' from '${describeSecretReference(authProfilesSecret)}': ${message}`,
					{ cause: error },
				);
			}
		}),
	);
	const resolveErrors = resolveResults
		.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
		.map((result) =>
			result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
		);
	if (resolveErrors.length > 0) {
		throw new AggregateError(
			resolveErrors,
			`Failed to resolve ${String(resolveErrors.length)} OpenClaw auth profile secret(s) for zone '${zone.id}'.`,
		);
	}
	return resolveResults
		.filter(
			(
				result,
			): result is PromiseFulfilledResult<{
				readonly agentId: string;
				readonly authProfiles: string;
			}> => result.status === 'fulfilled',
		)
		.map((result) => result.value);
}

async function buildEffectiveOpenClawConfig(
	zone: GatewayZoneConfig,
): Promise<Readonly<Record<string, unknown>>> {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	const gatewayTokenSecretName = zone.gateway.controlAuth.secret;
	const gatewayTokenSecret = zone.secrets[gatewayTokenSecretName];
	if (!gatewayTokenSecret) {
		throw new Error(
			`Zone '${zone.id}' secret '${gatewayTokenSecretName}' is missing. Add an explicit 1Password or environment reference for the gateway token.`,
		);
	}
	if (!isSourceAwareSecretReference(gatewayTokenSecret)) {
		throw new Error(`Zone '${zone.id}' secret '${gatewayTokenSecretName}' has an invalid shape.`);
	}

	try {
		if (gatewayTokenSecret.source === '1password' && !gatewayTokenSecret.ref) {
			throw new Error(
				`Zone '${zone.id}' secret '${gatewayTokenSecretName}' is missing 'ref'. Add an explicit 1Password reference for the gateway token.`,
			);
		}
		if (gatewayTokenSecret.source === 'environment' && !gatewayTokenSecret.envVar) {
			throw new Error(
				`Zone '${zone.id}' secret '${gatewayTokenSecretName}' is missing 'envVar'. Add an explicit environment variable name.`,
			);
		}
		const openClawGatewayTokenSecretRef: OpenClawSecretRef = {
			id: gatewayTokenSecretName,
			provider: 'default',
			source: 'env',
		};
		const rawBaseConfig = await readFile(zone.gateway.config, 'utf8');
		const parsedBaseConfig: unknown = JSON.parse(rawBaseConfig);
		if (!isObjectRecord(parsedBaseConfig)) {
			throw new Error(`OpenClaw config at '${zone.gateway.config}' must be a JSON object.`);
		}
		if (zone.observability?.mode === 'collector') {
			assertObservabilityCompatibleLoggingConfig(parsedBaseConfig);
		}
		const runtimePluginConfigs = {
			...zone.runtimePluginConfigs,
			...(zone.observability?.mode === 'collector'
				? {
						[diagnosticsOtelPluginId]: {},
					}
				: {}),
			gondolin: {
				...(isObjectRecord(zone.runtimePluginConfigs?.gondolin)
					? zone.runtimePluginConfigs.gondolin
					: {}),
				zoneId: zone.id,
			},
		};
		const config = isObjectRecord(parsedBaseConfig.gateway) ? parsedBaseConfig.gateway : {};
		const existingAuthConfig = isObjectRecord(config.auth) ? config.auth : {};
		const effectiveDiagnosticsConfig = buildEffectiveDiagnosticsConfig(parsedBaseConfig, zone);
		const effectiveConfig = {
			...parsedBaseConfig,
			logging: buildEffectiveLoggingConfig(parsedBaseConfig),
			...(effectiveDiagnosticsConfig === undefined
				? {}
				: { diagnostics: effectiveDiagnosticsConfig }),
			gateway: {
				...config,
				auth: {
					...existingAuthConfig,
					mode: 'token',
					token: openClawGatewayTokenSecretRef,
				},
			},
			meta: {
				...(isObjectRecord(parsedBaseConfig.meta) ? parsedBaseConfig.meta : {}),
				lastTouchedAt: new Date().toISOString(),
				lastTouchedVersion: 'agent-vm',
			},
			mcp: buildEffectiveMcpConfig(parsedBaseConfig, zone.runtimeMcpServers),
			plugins: buildEffectivePluginsConfig(parsedBaseConfig, runtimePluginConfigs, {
				includeManagedDiagnosticsOtelInstall: zone.observability?.mode === 'collector',
			}),
			secrets: buildEffectiveSecretsConfig(parsedBaseConfig),
		};
		return effectiveConfig;
	} catch (error) {
		const message = formatSafeOpenClawErrorMessage(error);
		throw new Error(
			`Failed to build effective OpenClaw config for zone '${zone.id}' from '${zone.gateway.config}' using secret '${describeSecretReference(gatewayTokenSecret)}': ${message}`,
			{ cause: error },
		);
	}
}

async function buildEffectiveOpenClawConfigContent(zone: GatewayZoneConfig): Promise<string> {
	return `${JSON.stringify(await buildEffectiveOpenClawConfig(zone), null, 2)}\n`;
}

async function writeEffectiveOpenClawConfig(zone: GatewayZoneConfig): Promise<void> {
	const content = await buildEffectiveOpenClawConfigContent(zone);
	try {
		const effectiveConfigPath = getEffectiveOpenClawConfigHostPath(zone);
		await mkdir(zone.gateway.stateDir, { recursive: true, mode: 0o700 });
		await chmod(zone.gateway.stateDir, 0o700);
		await writeFileAtomically(effectiveConfigPath, content, { mode: 0o600 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to write effective OpenClaw config for zone '${zone.id}': ${message}`, {
			cause: error,
		});
	}
}

async function preflightEffectiveOpenClawConfig(zone: GatewayZoneConfig): Promise<void> {
	const content = await buildEffectiveOpenClawConfigContent(zone);
	try {
		await mkdir(zone.gateway.stateDir, { recursive: true, mode: 0o700 });
		await chmod(zone.gateway.stateDir, 0o700);
		await assertEffectiveConfigPathWritable(zone, content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to preflight effective OpenClaw config for zone '${zone.id}': ${message}`,
			{ cause: error },
		);
	}
}

export function buildOpenClawFrameworkServiceBootMetadata(
	zone: GatewayZoneConfig,
): ManagedOpenClawServiceBootMetadata {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	return {
		bootEntry: 'openclaw-gateway',
		configurationInputPath: managedFrameworkConfigurationInputPath,
		environmentInputPath: managedFrameworkEnvironmentInputPath,
		framework: 'openclaw',
		ingress: {
			guestPort: openClawGatewayGuestPort,
			kind: 'framework-http',
		},
		logIdentity: {
			guestPath: '/var/log/agent-vm/openclaw-service.log',
			serviceName: zone.observability?.framework.serviceName ?? 'agent-vm-openclaw',
		},
		readiness: {
			guestPort: openClawGatewayGuestPort,
			kind: 'framework-http',
			path: '/readyz',
		},
		role: 'framework-service',
	};
}

function buildOpenClawFrameworkServiceEnvironment(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): Readonly<Record<string, string>> {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	const { environmentSecrets } = mergeRuntimeGatewaySecrets(
		splitAllowedOpenClawGatewaySecrets(
			zone,
			resolvedSecrets,
			'openclaw-managed-framework-service-raw-env-secrets',
		),
		{
			logPrefix: 'openclaw-managed-framework-service-runtime-secrets',
			runtimeEnvironment: zone.runtimeEnvironment,
			runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
		},
	);
	assertAllowedOpenClawEnvironmentSecrets(
		zone,
		environmentSecrets,
		'openclaw-managed-framework-service-runtime-raw-env-secrets',
	);
	assertNoOpenClawPrivateEnvironmentCollisions({
		environmentSecrets,
		runtimeEnvironment: zone.runtimeEnvironment,
		runtimePrivateEnvironment: zone.runtimePrivateEnvironment,
	});
	return Object.freeze({
		HOME: '/home/openclaw',
		NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
		OPENCLAW_CONFIG_PATH: managedFrameworkConfigurationInputPath,
		OPENCLAW_HOME: '/home/openclaw',
		OPENCLAW_STATE_DIR: openClawStateDirVmPath,
		PATH: openClawGatewayGuestPath,
		PIP_CACHE_DIR: '/work/cache/pip',
		PNPM_HOME: '/pnpm',
		TEMP: '/work/tmp',
		TMP: '/work/tmp',
		TMPDIR: '/work/tmp',
		UV_CACHE_DIR: '/work/cache/uv',
		npm_config_cache: '/work/cache/npm',
		pnpm_config_store_dir: '/work/cache/pnpm/store',
		...environmentSecrets,
		...zone.runtimePrivateEnvironment,
		NODE_OPTIONS: composeNodeOptions(environmentSecrets.NODE_OPTIONS),
	});
}

export async function buildOpenClawFrameworkServiceBootInputs(
	options: BuildManagedFrameworkServiceBootInputsOptions,
): Promise<ManagedFrameworkServiceBootInputs> {
	const environment = buildOpenClawFrameworkServiceEnvironment(
		options.zone,
		options.resolvedSecrets,
	);
	return Object.freeze({
		configuration: await buildEffectiveOpenClawConfig(options.zone),
		environment,
		kind: 'configuration-only',
	});
}

export const openclawLifecycle = {
	executionModel: 'managed-gateway',
	authConfig: {
		listProvidersCommand: 'openclaw models auth list --format plain 2>/dev/null || echo ""',
		buildLoginCommand: (
			provider: string,
			options: {
				readonly agentId?: string;
				readonly deviceCode?: boolean;
				readonly profileId?: string;
			} = {},
		): string =>
			[
				'openclaw models auth',
				...(options.agentId ? [`--agent ${shellQuote(options.agentId)}`] : []),
				`login --provider ${shellQuote(provider)}`,
				...(options.profileId ? [`--profile-id ${shellQuote(options.profileId)}`] : []),
				...(options.deviceCode === true ? ['--device-code'] : []),
			].join(' '),
		buildProfileListCommand: (
			provider: string,
			options: {
				readonly agentId: string;
			},
		): string =>
			[
				'openclaw models auth',
				`--agent ${shellQuote(options.agentId)}`,
				`list --provider ${shellQuote(provider)}`,
			].join(' '),
	},

	buildVmRequirements({
		gatewayCacheDir,
		projectNamespace,
		resolvedSecrets,
		runtimeDir,
		tcpPool,
		zone,
	}: BuildGatewayVmRequirementsOptions): GatewayVmRequirements {
		if (zone.gateway.type !== 'openclaw') {
			throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
		}
		const { mediatedSecrets } = mergeRuntimeGatewaySecrets(
			splitAllowedOpenClawGatewaySecrets(zone, resolvedSecrets, 'openclaw-vm-raw-env-secrets'),
			{
				logPrefix: 'openclaw-vm-runtime-secrets',
				runtimeEnvironment: zone.runtimeEnvironment,
				runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
			},
		);
		const sshEgress = createManagedGitReadOnlySshEgressOptions({
			gitReadAllowlistRepos: zone.gitReadAllowlistRepos,
		});
		return {
			allowedHosts: mergeGatewayAllowedHosts(zone.egressHosts, zone.observability),
			environment: {
				HOME: '/home/openclaw',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				OPENCLAW_CONFIG_PATH: effectiveOpenClawConfigVmPath,
				OPENCLAW_HOME: '/home/openclaw',
				OPENCLAW_STATE_DIR: openClawStateDirVmPath,
				PATH: openClawGatewayGuestPath,
				PIP_CACHE_DIR: '/work/cache/pip',
				PNPM_HOME: '/pnpm',
				TEMP: '/work/tmp',
				TMP: '/work/tmp',
				TMPDIR: '/work/tmp',
				UV_CACHE_DIR: '/work/cache/uv',
				npm_config_cache: '/work/cache/npm',
				pnpm_config_store_dir: '/work/cache/pnpm/store',
				// VM-wide environment stays structural. Framework secrets,
				// controller-private values, and authored NODE_OPTIONS are
				// materialized only into the protected framework-service input.
				NODE_OPTIONS: composeNodeOptions(undefined),
			},
			mediatedSecrets: {
				...mediatedSecrets,
			},
			rootfsMode: 'cow',
			...(zone.gateway.runtimeRootfsSize
				? { runtimeRootfsSize: zone.gateway.runtimeRootfsSize }
				: {}),
			sessionLabel: buildGatewaySessionLabelValue(projectNamespace, zone.id),
			...(sshEgress === undefined ? {} : { sshEgress }),
			tcpHosts: buildGatewayTcpHosts(tcpPool),
			websocketUpgrades: zone.websocketUpgrades ?? [],
			mounts: {
				[openClawCacheDirVmPath]: {
					access: 'read-write',
					hostPath: gatewayCacheDir,
					kind: 'host-directory',
				},
				'/home/openclaw/.openclaw/state': {
					access: 'read-write',
					hostPath: zone.gateway.stateDir,
					kind: 'host-directory',
				},
				[openClawZoneFilesDirVmPath]: {
					access: 'read-write',
					hostPath: zone.gateway.zoneFilesDir,
					kind: 'host-directory',
				},
				[agentVmLogsDirVmPath]: {
					access: 'read-write',
					hostPath: path.join(runtimeDir, 'zones', zone.id, 'logs'),
					kind: 'host-directory',
				},
			},
		};
	},

	buildFrameworkServiceBootMetadata: buildOpenClawFrameworkServiceBootMetadata,
	buildFrameworkServiceBootInputs: buildOpenClawFrameworkServiceBootInputs,

	async prepareHostState(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void> {
		await writeEffectiveOpenClawConfig(zone);
		await writeManagedDiagnosticsOtelInstallRecord(zone);
		await writeAuthProfilesIfConfigured(zone, secretResolver);
	},

	async preflightHostState(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void> {
		await preflightEffectiveOpenClawConfig(zone);
		await preflightManagedDiagnosticsOtelInstallRecord(zone);
		await preflightAuthProfilesIfConfigured(zone, secretResolver);
	},
} satisfies ManagedGatewayLifecycle;
