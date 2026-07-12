import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayVmSpec,
	SplitResolvedGatewaySecretsResult,
} from '@agent-vm/gateway-interface';
import {
	buildGatewaySessionLabel as buildGatewaySessionLabelValue,
	composeNodeOptions,
	FORCE_IPV4_EGRESS_NODE_OPTIONS,
	GATEWAY_CONTROL_PRIVATE_ENVIRONMENT_NAMES,
	gatewayVmAllowedHosts,
	mergeRuntimeGatewaySecrets,
	normalizeGitReposForSshReadAllowlist,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-interface';
import {
	createGitReadOnlySshEgressOptions,
	type ManagedSshEgressOptions,
	writeFileAtomically,
} from '@agent-vm/gondolin-adapter';
import {
	redactOnePasswordReferences,
	type SecretRef,
	type SecretResolver,
} from '@agent-vm/secret-management';

const effectiveOpenClawConfigFileName = 'effective-openclaw.json';
const effectiveOpenClawConfigVmPath = `/home/openclaw/.openclaw/state/${effectiveOpenClawConfigFileName}`;
const openClawStateDirVmPath = '/home/openclaw/.openclaw/state';
const openClawCacheDirVmPath = '/home/openclaw/.openclaw/cache';
const openClawZoneFilesDirVmPath = '/zone';
const agentVmLogsDirVmPath = '/agent-vm/logs';
const openClawRuntimeLogFileVmPath = `${agentVmLogsDirVmPath}/openclaw-YYYY-MM-DD.log`;
const openClawGatewayBootLogFileVmPath = `${agentVmLogsDirVmPath}/gateway-boot-latest.log`;
const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
const openClawRuntimeSecretsEnvFilePath = '/run/openclaw/secrets.env';
const openClawGatewayTokenEnvFilePath = '/run/openclaw/gateway-token.env';
const openClawCommandVmPath = '/usr/local/bin/openclaw';
const openClawGatewayGuestPort = 18789;
const openClawProcessSupervisorHelperVmPath =
	'/usr/local/libexec/agent-vm-openclaw-process-supervisor';
const openClawProcessSupervisorStateDirVmPath = '/run/agent-vm/openclaw-process-supervisor';
const openClawGatewayGuestPath =
	'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const diagnosticsOtelPluginId = 'diagnostics-otel';
const diagnosticsOtelPackageName = '@openclaw/diagnostics-otel';
const diagnosticsOtelGlobalPackageVmPath = '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel';
const deprecatedMcpPortalPluginId = 'mcp-portal';
const openClawInstalledPluginDirectoryName = 'plugins';
const openClawInstalledPluginIndexFileName = 'installs.json';
const gondolinPluginConfigFields = new Set([
	'controlSession',
	'controllerUrl',
	'profileId',
	'toolPortal',
	'zoneGitToken',
	'zoneGitTokenEnv',
	'zoneId',
]);
const gondolinControlSessionConfigFields = new Set([
	'bootId',
	'callerContextProofKey',
	'controllerEpoch',
	'generationId',
	'peerId',
	'processEpoch',
	'verifierPublicKeyPem',
]);
const gondolinToolPortalConfigFields = new Set(['configDir']);

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
}): ManagedSshEgressOptions | undefined {
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
	return createGitReadOnlySshEgressOptions({
		agent,
		allowedHosts: normalizedAllowlist.allowedHosts,
		allowedRepos: normalizedAllowlist.allowedRepos,
	});
}

function buildOpenClawBootstrapCommand(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): string {
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
	}
	const { environmentSecrets } = mergeRuntimeGatewaySecrets(
		splitAllowedOpenClawGatewaySecrets(zone, resolvedSecrets, 'openclaw-bootstrap-raw-env-secrets'),
		{
			logPrefix: 'openclaw-bootstrap-runtime-secrets',
			runtimeEnvironment: zone.runtimeEnvironment,
			runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
		},
	);
	assertAllowedOpenClawEnvironmentSecrets(
		zone,
		environmentSecrets,
		'openclaw-bootstrap-runtime-raw-env-secrets',
	);
	const environmentLines = [
		'export OPENCLAW_HOME=/home/openclaw',
		`export OPENCLAW_CONFIG_PATH=${effectiveOpenClawConfigVmPath}`,
		`export OPENCLAW_STATE_DIR=${openClawStateDirVmPath}`,
		'export PNPM_HOME=/pnpm',
		'export PATH=/pnpm:$PATH',
		'export TMPDIR=/work/tmp',
		'export TMP=/work/tmp',
		'export TEMP=/work/tmp',
		'export npm_config_cache=/work/cache/npm',
		'export pnpm_config_store_dir=/work/cache/pnpm/store',
		'export PIP_CACHE_DIR=/work/cache/pip',
		'export UV_CACHE_DIR=/work/cache/uv',
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
		// Prepend each forced IPv4-preference flag only when it is not
		// already present. The VM env normally carries these flags
		// already; the profile keeps interactive shells safe without
		// duplicating the boot-log value.
		...FORCE_IPV4_EGRESS_NODE_OPTIONS.split(' ').map(
			(nodeOptionFlag) =>
				`case " \${NODE_OPTIONS:-} " in *" ${nodeOptionFlag} "*) ;; *) export NODE_OPTIONS="${nodeOptionFlag}\${NODE_OPTIONS:+ \${NODE_OPTIONS}}";; esac`,
		),
	];
	const secretEnvironmentNames = Object.entries({
		...environmentSecrets,
		...zone.runtimeEnvironment,
	}).map(([secretName, secretValue]) => {
		assertShellSafeEnvName(secretName);
		assertShellProfileSafeSecretValue(secretName, secretValue);
		return secretName;
	});
	const secretsFileCommand =
		secretEnvironmentNames.length === 0
			? `: > ${openClawRuntimeSecretsEnvFilePath} && `
			: `{ ${secretEnvironmentNames.map(runtimeSecretLiteralExportCommand).join('; ')}; } > ${openClawRuntimeSecretsEnvFilePath} && `;
	const gatewayTokenSecretName = zone.gateway.controlAuth.secret;
	const gatewayTokenFileCommand = secretEnvironmentNames.includes(gatewayTokenSecretName)
		? `{ ${runtimeSecretLiteralExportCommand(gatewayTokenSecretName)}; } > ${openClawGatewayTokenEnvFilePath} && `
		: `: > ${openClawGatewayTokenEnvFilePath} && `;
	const sshConfigLines = ['Host tool-*.vm.host', '  AddressFamily inet'];
	const sshConfigCommand =
		`mkdir -p /root/.ssh /home/openclaw/.ssh && ` +
		`printf '%s\\n' ${sshConfigLines.map((line) => shellQuote(line)).join(' ')} > /root/.ssh/config && ` +
		'cp /root/.ssh/config /home/openclaw/.ssh/config && ' +
		'chown -R openclaw:openclaw /home/openclaw/.ssh && ' +
		'chmod 700 /root/.ssh /home/openclaw/.ssh && ' +
		'chmod 600 /root/.ssh/config /home/openclaw/.ssh/config && ';
	const diagnosticsOtelRegistryCommand =
		zone.observability?.mode === 'collector' ? 'openclaw plugins registry --refresh && ' : '';
	const processSupervisorHelperBase64 = Buffer.from(
		buildOpenClawProcessSupervisorHelperSource(),
		'utf8',
	).toString('base64');
	const processSupervisorInstallCommand =
		`mkdir -p /usr/local/libexec ${openClawProcessSupervisorStateDirVmPath} && ` +
		`printf '%s' ${shellQuote(processSupervisorHelperBase64)} | base64 -d > ${openClawProcessSupervisorHelperVmPath} && ` +
		`chmod 700 ${openClawProcessSupervisorHelperVmPath} ${openClawProcessSupervisorStateDirVmPath} && `;

	return (
		`mkdir -p /root /etc/profile.d /run/openclaw /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv && chown -R openclaw:openclaw /work && cat > ${openClawShellEnvFilePath} << 'ENVEOF'\n` +
		environmentLines.join('\n') +
		'\nENVEOF\n' +
		`chmod 644 ${openClawShellEnvFilePath} && ` +
		secretsFileCommand +
		`chmod 600 ${openClawRuntimeSecretsEnvFilePath} && ` +
		gatewayTokenFileCommand +
		`chmod 600 ${openClawGatewayTokenEnvFilePath} && ` +
		sshConfigCommand +
		processSupervisorInstallCommand +
		diagnosticsOtelRegistryCommand +
		'touch /root/.bashrc && ' +
		`grep -qxF 'source ${openClawShellEnvFilePath}' /root/.bashrc || echo 'source ${openClawShellEnvFilePath}' >> /root/.bashrc && ` +
		'touch /root/.bash_profile && ' +
		"grep -qxF 'source /root/.bashrc' /root/.bash_profile || echo 'source /root/.bashrc' >> /root/.bash_profile"
	);
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

function buildOpenClawProcessSupervisorHelperSource(): string {
	return `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const directory = '${openClawProcessSupervisorStateDirVmPath}';
const requestPath = path.join(directory, 'request-v1.json');
const receiptPath = path.join(directory, 'receipt-v1.json');
const statePath = path.join(directory, 'state-v1.json');
const failurePath = path.join(directory, 'failure-v1.json');
const lockPath = path.join(directory, 'operation.lock');
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\\0') === [...keys].sort().join('\\0');
const validGateway = (value) => exactKeys(value, ['controllerEpoch', 'gatewayEpochId', 'gatewayVmId']) && identifier.test(value.controllerEpoch) && identifier.test(value.gatewayEpochId) && identifier.test(value.gatewayVmId);
const parseRequest = (value) => {
  const common = ['actionId', 'contractVersion', 'expectedProcessEpoch', 'gateway', 'kind'];
  const keys = value?.kind === 'start' ? [...common, 'selectedProcessEpoch'] : common;
  if (!exactKeys(value, keys) || value.contractVersion !== 1 || !['contain', 'observe', 'start', 'terminate-for-reliability-test'].includes(value.kind) || !identifier.test(value.actionId) || !validGateway(value.gateway) || (value.expectedProcessEpoch !== null && !identifier.test(value.expectedProcessEpoch)) || (value.kind === 'start' && !identifier.test(value.selectedProcessEpoch)) || (value.kind === 'terminate-for-reliability-test' && value.expectedProcessEpoch === null)) throw new Error('invalid-request');
  return value;
};
const atomicWrite = (filePath, value) => {
  const temporaryPath = filePath + '.' + process.pid + '.tmp';
  writeFileSync(temporaryPath, JSON.stringify(value) + '\\n', { mode: 0o600 });
  renameSync(temporaryPath, filePath);
};
const sameGateway = (left, right) => left && left.controllerEpoch === right.controllerEpoch && left.gatewayEpochId === right.gatewayEpochId && left.gatewayVmId === right.gatewayVmId;
const populated = (groupPath) => {
  const events = readFileSync(path.join(groupPath, 'cgroup.events'), 'utf8');
  const match = /^populated ([01])$/mu.exec(events);
  if (!match) throw new Error('cgroup-events-unavailable');
  return match[1] === '1';
};
const waitForPopulation = (groupPath, expected) => {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (populated(groupPath) === expected) return true;
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return false;
};
const ensureCgroup2 = () => {
  mkdirSync('/sys/fs/cgroup', { recursive: true });
  const mounts = readFileSync('/proc/mounts', 'utf8');
  if (!mounts.split('\\n').some((line) => line.split(' ')[1] === '/sys/fs/cgroup' && line.split(' ')[2] === 'cgroup2')) {
    const mounted = spawnSync('mount', ['-t', 'cgroup2', 'none', '/sys/fs/cgroup']);
    if (mounted.status !== 0) throw new Error('cgroup-mount-failed');
  }
};
mkdirSync(directory, { recursive: true, mode: 0o700 });
let lock;
try { lock = openSync(lockPath, 'wx', 0o600); } catch { process.exit(73); }
const terminated = Symbol('terminated');
const terminate = (exitCode) => { process.exitCode = exitCode; throw terminated; };
let activeRequest = null;
let activeStage = 'initializing';
try {

  activeStage = 'read-request';
  activeStage = 'parse-request-json';
  const requestValue = JSON.parse(readFileSync(0, 'utf8'));
  activeStage = 'validate-request';
  const request = parseRequest(requestValue);
  activeRequest = request;
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  activeStage = 'persist-request-audit';
  atomicWrite(requestPath, request);
  activeStage = 'read-state';
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { contractVersion: 1, gateway: request.gateway, currentProcessEpoch: null, cgroupName: null, status: 'absent', actionOrder: [], actions: {} };
  const recordOperationStage = (stage) => {
    activeStage = stage;
    state = { ...state, lastOperation: { actionId: request.actionId, kind: request.kind, stage } };
    atomicWrite(statePath, state);
  };
  const writeReceipt = (receipt) => {
    const actionOrder = [...state.actionOrder.filter((actionId) => actionId !== request.actionId), request.actionId].slice(-128);
    const actions = { ...state.actions, [request.actionId]: { digest, receipt } };
    for (const actionId of Object.keys(actions)) if (!actionOrder.includes(actionId)) delete actions[actionId];
    state = { ...state, actionOrder, actions };
    atomicWrite(statePath, state); atomicWrite(receiptPath, receipt);
  };
  const priorAction = state.actions[request.actionId];
  if (priorAction) {
    if (priorAction.digest !== digest) {
      atomicWrite(receiptPath, { actionId: request.actionId, cgroup: { name: state.cgroupName, populated: state.cgroupName ? populated(path.join('/sys/fs/cgroup', state.cgroupName)) : false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, reason: 'action-reused', status: 'refused' });
      terminate(2);
    }
    atomicWrite(receiptPath, priorAction.receipt); terminate(0);
  }
  const refuse = (reason) => { writeReceipt({ actionId: request.actionId, cgroup: { name: state.cgroupName, populated: state.cgroupName ? populated(path.join('/sys/fs/cgroup', state.cgroupName)) : false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, reason, status: 'refused' }); terminate(2); };
  if (!sameGateway(state.gateway, request.gateway)) refuse('gateway-fence-mismatch');
  if (state.currentProcessEpoch !== request.expectedProcessEpoch) refuse('process-fence-mismatch');
  if (request.kind === 'start') {
    if (state.currentProcessEpoch !== null || !['absent', 'contained'].includes(state.status)) refuse('process-overlap');
    recordOperationStage('ensure-cgroup2');
    ensureCgroup2();
    const cgroupName = 'agent-vm-' + createHash('sha256').update(request.gateway.gatewayEpochId + '\\0' + request.selectedProcessEpoch).digest('hex').slice(0, 24);
    const groupPath = path.join('/sys/fs/cgroup', cgroupName);
    recordOperationStage('create-cgroup');
    mkdirSync(groupPath, { mode: 0o700 });
    recordOperationStage('inspect-created-cgroup');
    if (populated(groupPath)) refuse('process-overlap');
    recordOperationStage('bind-process');
    state = { ...state, currentProcessEpoch: request.selectedProcessEpoch, cgroupName, status: 'starting' };
    writeReceipt({ actionId: request.actionId, cgroup: { name: cgroupName, populated: false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: request.selectedProcessEpoch, reason: 'helper-failed', status: 'incomplete' });
    try {
      const logFd = openSync('${openClawGatewayBootLogFileVmPath}', 'a', 0o600);
      const launch = 'echo $$ > ' + JSON.stringify(path.join(groupPath, 'cgroup.procs')) + '; set -a; . ${openClawRuntimeSecretsEnvFilePath}; set +a; cd /home/openclaw; exec ${openClawCommandVmPath} gateway --port ${openClawGatewayGuestPort}';
      let child;
      try {
        child = spawn('/bin/sh', ['-c', launch], { detached: true, stdio: ['ignore', logFd, logFd] });
      } finally {
        closeSync(logFd);
      }
      child.unref();
      if (!waitForPopulation(groupPath, true)) throw new Error('cgroup-membership-unproven');
      state = { ...state, status: 'running' };
      writeReceipt({ actionId: request.actionId, cgroup: { name: cgroupName, populated: true }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: request.selectedProcessEpoch, status: 'completed' });
    } catch (error) {
      const isPopulated = populated(groupPath);
      const reason = error instanceof Error && error.message === 'cgroup-membership-unproven' ? 'cgroup-unavailable' : 'helper-failed';
      state = { ...state, status: isPopulated ? 'starting' : 'exited' };
      writeReceipt({ actionId: request.actionId, cgroup: { name: cgroupName, populated: isPopulated }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: request.selectedProcessEpoch, reason, status: 'incomplete' });
      terminate(2);
    }
  } else if (request.kind === 'observe') {
    if (state.currentProcessEpoch === null || state.cgroupName === null) {
      writeReceipt({ actionId: request.actionId, cgroup: { name: null, populated: false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: null, status: 'completed' });
    } else {
      const isPopulated = populated(path.join('/sys/fs/cgroup', state.cgroupName));
      state = { ...state, status: isPopulated ? 'running' : 'exited' };
      writeReceipt({ actionId: request.actionId, cgroup: { name: state.cgroupName, populated: isPopulated }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, status: 'completed' });
    }
  } else if (request.kind === 'terminate-for-reliability-test') {
	if (state.currentProcessEpoch === null || state.cgroupName === null) refuse('process-fence-mismatch');
	const groupPath = path.join('/sys/fs/cgroup', state.cgroupName);
	try {
	  if (!existsSync(path.join(groupPath, 'cgroup.kill'))) throw new Error('reliability-cgroup-kill-unavailable');
	  writeFileSync(path.join(groupPath, 'cgroup.kill'), '1\\n');
	  if (!waitForPopulation(groupPath, false)) throw new Error('cgroup-empty-unproven');
	  state = { ...state, status: 'exited' };
	  writeReceipt({ actionId: request.actionId, cgroup: { emptyObserved: true, name: state.cgroupName, populated: false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, status: 'completed' });
	} catch (error) {
	  const reason = error instanceof Error && error.message === 'cgroup-empty-unproven' ? 'cgroup-empty-unproven' : 'cgroup-unavailable';
	  writeReceipt({ actionId: request.actionId, cgroup: { name: state.cgroupName, populated: populated(groupPath) }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, reason, status: 'incomplete' });
	  terminate(2);
	}
  } else {
    if (state.currentProcessEpoch === null || state.cgroupName === null) refuse('process-fence-mismatch');
    const groupPath = path.join('/sys/fs/cgroup', state.cgroupName);
    try {
      const containedProcessEpoch = state.currentProcessEpoch;
      const containedCgroupName = state.cgroupName;
      if (existsSync(groupPath)) {
        if (populated(groupPath)) {
          if (!existsSync(path.join(groupPath, 'cgroup.kill'))) throw new Error('cgroup-kill-unavailable');
          writeFileSync(path.join(groupPath, 'cgroup.kill'), '1\\n');
          if (!waitForPopulation(groupPath, false)) throw new Error('cgroup-empty-unproven');
        }
        rmdirSync(groupPath);
      } else if (state.status !== 'exited') {
        throw new Error('cgroup-absence-unproven');
      }
      state = { ...state, currentProcessEpoch: null, cgroupName: null, status: 'contained' };
      writeReceipt({ actionId: request.actionId, cgroup: { emptyObserved: true, name: containedCgroupName, populated: false }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: containedProcessEpoch, status: 'completed' });
    } catch (error) {
      const reason = error instanceof Error && error.message === 'cgroup-empty-unproven' ? 'cgroup-empty-unproven' : 'cgroup-unavailable';
      const isPopulated = existsSync(groupPath) ? populated(groupPath) : false;
      writeReceipt({ actionId: request.actionId, cgroup: { name: state.cgroupName, populated: isPopulated }, contractVersion: 1, expectedProcessEpoch: request.expectedProcessEpoch, gateway: request.gateway, kind: request.kind, observedProcessEpoch: state.currentProcessEpoch, reason, status: 'incomplete' });
      terminate(2);
    }
  }
} catch (error) {
  if (error !== terminated) {
    try {
      const candidateErrorCode = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown';
      const errorCode = /^[A-Z0-9_]{1,32}$/.test(candidateErrorCode) ? candidateErrorCode : 'unknown';
      atomicWrite(failurePath, { actionId: activeRequest?.actionId ?? null, errorCode, kind: activeRequest?.kind ?? null, stage: activeStage });
    } catch {}
    process.stderr.write('agent-vm-process-supervisor-failure:' + activeStage + '\\n');
    process.exitCode = 1;
  }
} finally { closeSync(lock); rmSync(lockPath, { force: true }); }
`;
}

function buildOpenClawGatewayStartCommand(): string {
	return [
		`{ printf 'gateway-boot: NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" > ${openClawGatewayBootLogFileVmPath}; }`,
		`printf 'gateway-supervisor: controller-owned helper ready; awaiting typed request\\n' >> ${openClawGatewayBootLogFileVmPath}`,
	].join(' && ');
}

export const processSupervisorHelperTestInternals = {
	buildOpenClawProcessSupervisorHelperSource,
};

function includesShellUnsafeControlByte(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

function assertShellSafeEnvName(secretName: string): void {
	if (!/^[_A-Za-z][_0-9A-Za-z]*$/u.test(secretName)) {
		throw new Error(
			`OpenClaw env-injected gateway secret '${secretName}' must be a shell-safe environment variable name.`,
		);
	}
}

function assertShellProfileSafeSecretValue(secretName: string, value: string): void {
	if (includesShellUnsafeControlByte(value)) {
		throw new Error(
			`OpenClaw env-injected gateway secret '${secretName}' must be a single-line value without control bytes. Use http-mediation for secrets that require structured transport.`,
		);
	}
}

function runtimeSecretLiteralExportCommand(secretName: string): string {
	const runtimeSecretValue = `"\${${secretName}?missing runtime secret ${secretName}}"`;
	return `secret_value=${runtimeSecretValue} && escaped_secret_value="$(printf '%s' "$secret_value" | sed 's/["\\\\$\`]/\\\\&/g')" && printf 'export ${secretName}="%s"\\n' "$escaped_secret_value"`;
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

function assertNoRemovedGondolinRawControlConfig(config: Readonly<Record<string, unknown>>): void {
	if (Object.hasOwn(config, 'controllerUrl')) {
		throw new Error('Gondolin plugin config no longer accepts controllerUrl.');
	}
	if (Object.hasOwn(config, 'zoneGitToken') || Object.hasOwn(config, 'zoneGitTokenEnv')) {
		throw new Error('Gondolin plugin config no longer accepts zone git token fields.');
	}
	const rawControlSessionConfig = config.controlSession;
	if (
		isObjectRecord(rawControlSessionConfig) &&
		Object.hasOwn(rawControlSessionConfig, 'callerContextProofKey')
	) {
		throw new Error('Gondolin plugin controlSession no longer accepts callerContextProofKey.');
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

function assertRequiredGondolinStringField(options: {
	readonly fieldName: string;
	readonly label: string;
	readonly record: Readonly<Record<string, unknown>>;
}): void {
	const fieldValue = options.record[options.fieldName];
	if (typeof fieldValue !== 'string') {
		throw new Error(`Gondolin plugin ${options.label} requires string ${options.fieldName}.`);
	}
	if (fieldValue.trim() === '') {
		throw new Error(`Gondolin plugin ${options.label} requires non-empty ${options.fieldName}.`);
	}
}

function assertOptionalManagedGondolinObjectField(options: {
	readonly config: Readonly<Record<string, unknown>>;
	readonly fieldName: 'controlSession' | 'toolPortal';
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

function assertManagedGondolinPluginConfig(options: {
	readonly config: Readonly<Record<string, unknown>>;
	readonly requireCompleteNestedConfig?: boolean;
}): void {
	const config = options.config;
	assertNoRemovedGondolinRawControlConfig(config);
	assertNoUnknownGondolinConfigFields({
		allowedFields: gondolinPluginConfigFields,
		label: 'config',
		record: config,
	});
	assertOptionalGondolinStringField({ fieldName: 'profileId', label: 'config', record: config });
	assertOptionalGondolinStringField({ fieldName: 'zoneId', label: 'config', record: config });
	const controlSessionConfig = assertOptionalManagedGondolinObjectField({
		config,
		fieldName: 'controlSession',
	});
	if (controlSessionConfig !== undefined) {
		assertNoUnknownGondolinConfigFields({
			allowedFields: gondolinControlSessionConfigFields,
			label: 'controlSession',
			record: controlSessionConfig,
		});
		for (const fieldName of [
			'bootId',
			'controllerEpoch',
			'generationId',
			'peerId',
			'processEpoch',
			'verifierPublicKeyPem',
		] as const) {
			assertOptionalGondolinStringField({
				fieldName,
				label: 'controlSession',
				record: controlSessionConfig,
			});
		}
		if (options.requireCompleteNestedConfig === true) {
			for (const fieldName of [
				'bootId',
				'controllerEpoch',
				'generationId',
				'peerId',
				'processEpoch',
				'verifierPublicKeyPem',
			] as const) {
				assertRequiredGondolinStringField({
					fieldName,
					label: 'controlSession',
					record: controlSessionConfig,
				});
			}
		}
	}
	const toolPortalConfig = assertOptionalManagedGondolinObjectField({
		config,
		fieldName: 'toolPortal',
	});
	if (toolPortalConfig !== undefined) {
		assertNoUnknownGondolinConfigFields({
			allowedFields: gondolinToolPortalConfigFields,
			label: 'toolPortal',
			record: toolPortalConfig,
		});
		assertOptionalGondolinStringField({
			fieldName: 'configDir',
			label: 'toolPortal',
			record: toolPortalConfig,
		});
		if (options.requireCompleteNestedConfig === true) {
			assertRequiredGondolinStringField({
				fieldName: 'configDir',
				label: 'toolPortal',
				record: toolPortalConfig,
			});
		}
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
				requireCompleteNestedConfig: true,
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

function managedToolPortalConfigDir(
	runtimePluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): string | undefined {
	const gondolinConfig = runtimePluginConfigs?.gondolin;
	if (!isObjectRecord(gondolinConfig)) {
		return undefined;
	}
	const toolPortalConfig = gondolinConfig.toolPortal;
	if (!isObjectRecord(toolPortalConfig)) {
		return undefined;
	}
	return typeof toolPortalConfig.configDir === 'string' ? toolPortalConfig.configDir : undefined;
}

function managedToolPortalEffectiveConfigMount(options: {
	readonly gatewayCacheDir: string;
	readonly runtimePluginConfigs:
		| Readonly<Record<string, Readonly<Record<string, unknown>>>>
		| undefined;
}):
	| {
			readonly guestPath: string;
			readonly hostPath: string;
	  }
	| undefined {
	const configDir = managedToolPortalConfigDir(options.runtimePluginConfigs);
	if (configDir === undefined) {
		return undefined;
	}
	const relativeConfigPath = path.posix.relative(openClawCacheDirVmPath, configDir);
	if (
		relativeConfigPath.length === 0 ||
		relativeConfigPath.startsWith('..') ||
		path.posix.isAbsolute(relativeConfigPath)
	) {
		return undefined;
	}
	return {
		guestPath: configDir,
		hostPath: path.join(options.gatewayCacheDir, relativeConfigPath),
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
	const { collector, openclaw } = zone.observability;
	return {
		...existingDiagnosticsConfig,
		enabled: true,
		flags: openclaw.diagnosticsFlags,
		otel: {
			captureContent: { enabled: false },
			enabled: true,
			endpoint: `http://${collector.host}:${String(collector.httpPort)}`,
			flushIntervalMs: openclaw.flushIntervalMs,
			logs: openclaw.logs,
			metrics: openclaw.metrics,
			protocol: 'http/protobuf',
			sampleRate: openclaw.sampleRate,
			serviceName: openclaw.serviceName,
			traces: openclaw.traces,
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
	const authProfilesByAgent = {
		...(zone.gateway.authProfilesRef ? { main: zone.gateway.authProfilesRef } : {}),
		...(zone.gateway.type === 'openclaw' ? (zone.gateway.authProfilesByAgent ?? {}) : {}),
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

async function buildEffectiveOpenClawConfigContent(zone: GatewayZoneConfig): Promise<string> {
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
		return `${JSON.stringify(effectiveConfig, null, 2)}\n`;
	} catch (error) {
		const message = formatSafeOpenClawErrorMessage(error);
		throw new Error(
			`Failed to build effective OpenClaw config for zone '${zone.id}' from '${zone.gateway.config}' using secret '${describeSecretReference(gatewayTokenSecret)}': ${message}`,
			{ cause: error },
		);
	}
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

export const openclawLifecycle: GatewayLifecycle = {
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

	buildVmSpec({
		gatewayCacheDir,
		projectNamespace,
		resolvedSecrets,
		runtimeDir,
		tcpPool,
		zone,
	}: BuildGatewayVmSpecOptions): GatewayVmSpec {
		if (zone.gateway.type !== 'openclaw') {
			throw new Error(`OpenClaw lifecycle cannot build gateway type '${zone.gateway.type}'.`);
		}
		const configDirectory = path.dirname(path.resolve(zone.gateway.config));
		const { environmentSecrets, mediatedSecrets } = mergeRuntimeGatewaySecrets(
			splitAllowedOpenClawGatewaySecrets(zone, resolvedSecrets, 'openclaw-vm-raw-env-secrets'),
			{
				logPrefix: 'openclaw-vm-runtime-secrets',
				runtimeEnvironment: zone.runtimeEnvironment,
				runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
			},
		);
		assertAllowedOpenClawEnvironmentSecrets(
			zone,
			environmentSecrets,
			'openclaw-vm-runtime-raw-env-secrets',
		);
		assertNoOpenClawPrivateEnvironmentCollisions({
			environmentSecrets,
			runtimeEnvironment: zone.runtimeEnvironment,
			runtimePrivateEnvironment: zone.runtimePrivateEnvironment,
		});
		const sshEgress = createManagedGitReadOnlySshEgressOptions({
			gitReadAllowlistRepos: zone.gitReadAllowlistRepos,
		});
		const toolPortalEffectiveConfigMount = managedToolPortalEffectiveConfigMount({
			gatewayCacheDir,
			runtimePluginConfigs: zone.runtimePluginConfigs,
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
				...environmentSecrets,
				...zone.runtimePrivateEnvironment,
				// NODE_OPTIONS goes AFTER the spread so a user-supplied
				// NODE_OPTIONS in environmentSecrets cannot drop the
				// forced IPv4-preference flags. composeNodeOptions
				// preserves the user value as additional flags.
				NODE_OPTIONS: composeNodeOptions(environmentSecrets.NODE_OPTIONS),
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
			vfsMounts: {
				'/home/openclaw/.openclaw/config': {
					hostPath: configDirectory,
					kind: 'realfs',
				},
				[openClawCacheDirVmPath]: {
					hostPath: gatewayCacheDir,
					kind: 'realfs',
				},
				...(toolPortalEffectiveConfigMount === undefined
					? {}
					: {
							[toolPortalEffectiveConfigMount.guestPath]: {
								hostPath: toolPortalEffectiveConfigMount.hostPath,
								kind: 'realfs-readonly',
							},
						}),
				'/home/openclaw/.openclaw/state': {
					hostPath: zone.gateway.stateDir,
					kind: 'realfs',
				},
				[openClawZoneFilesDirVmPath]: {
					hostPath: zone.gateway.zoneFilesDir,
					kind: 'realfs',
				},
				[agentVmLogsDirVmPath]: {
					hostPath: path.join(runtimeDir, 'zones', zone.id, 'logs'),
					kind: 'realfs',
				},
			},
		};
	},

	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec {
		return {
			bootstrapCommand: buildOpenClawBootstrapCommand(zone, resolvedSecrets),
			// printf NODE_OPTIONS into the boot log so an env-loss regression
			// (e.g. a future secrets.env or merge change that drops the
			// FORCE_IPV4_EGRESS_NODE_OPTIONS flags) is visible in the log
			// stream without SSHing into the VM.  See
			// FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-interface.
			startCommand: buildOpenClawGatewayStartCommand(),
			healthCheck: {
				type: 'http',
				port: openClawGatewayGuestPort,
				path: '/readyz',
			},
			serviceHealthCheck: {
				type: 'http',
				port: openClawGatewayGuestPort,
				path: '/health',
			},
			guestListenPort: openClawGatewayGuestPort,
			logPath: openClawGatewayBootLogFileVmPath,
		};
	},

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
};
