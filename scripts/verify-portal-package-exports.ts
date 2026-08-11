/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const requiredPortalPackageExports = [
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/agent-portal-sdk/adapter-boundary',
	'@agent-vm/agent-portal-sdk/approval-surface',
	'@agent-vm/agent-portal-sdk/artifact-surface',
	'@agent-vm/agent-portal-sdk/capability-description-surface',
	'@agent-vm/agent-portal-sdk/contracts',
	'@agent-vm/agent-portal-sdk/gateway-runtime-client',
	'@agent-vm/agent-portal-sdk/portal-call-surface',
	'@agent-vm/agent-portal-sdk/portal-event-surface',
	'@agent-vm/agent-portal-sdk/portable-contracts',
	'@agent-vm/agent-portal-sdk/testing',
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client',
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/controller-execution-contracts/controller-dispatch-boundary',
	'@agent-vm/controller-execution-contracts/controller-host-action-boundary',
	'@agent-vm/controller-execution-contracts/tool-vm-runner-boundary',
	'@agent-vm/controller-execution-contracts/testing',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/gateway-runtime',
	'@agent-vm/mcp-portal',
	'@agent-vm/mcp-portal/cli',
	'@agent-vm/mcp-portal/core',
	'@agent-vm/mcp-portal/mcp-proxy',
	'@agent-vm/mcp-portal/mcp-provider-backend',
	'@agent-vm/mcp-portal/portal-config',
	'@agent-vm/mcp-portal/portal-auth/agent-bearer-token',
	'@agent-vm/mcp-portal/portal-auth/hmac-env',
	'@agent-vm/mcp-portal/portal-auth/hmac-token',
	'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server',
	'@agent-vm/tool-portal',
	'@agent-vm/tool-portal/standalone-entrypoint',
	'@agent-vm/tool-portal/testing',
	'@agent-vm/worker-control-contracts',
] as const;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredPortalNamedExports = {
	'@agent-vm/agent-portal-sdk': [
		'CapabilityReferenceSchema',
		'JsonObjectSchema',
		'JsonValueSchema',
		'PortalCallRequestSchema',
		'PortalCallResultSchema',
		'PortalDescribeRequestSchema',
		'PortalDescribeResultSchema',
		'PortalErrorSchema',
		'PortalListRequestSchema',
		'PortalListResultSchema',
		'PortalSearchRequestSchema',
		'PortalSearchResultSchema',
		'SafeDiagnosticSchema',
		'createPortalCallSurfaceJsonSchemas',
	],
	'@agent-vm/agent-portal-sdk/adapter-boundary': [
		'PortalAdapterEnvelopeSchema',
		'TrustedAgentScopeSchema',
	],
	'@agent-vm/agent-portal-sdk/approval-surface': [
		'ApprovalDecisionReferenceSchema',
		'ApprovalRequiredResultSchema',
	],
	'@agent-vm/agent-portal-sdk/artifact-surface': [
		'ArtifactReferenceSchema',
		'PortalArtifactReadRequestSchema',
		'PortalArtifactReadResultSchema',
		'PortalArtifactRecordSchema',
		'PortalArtifactRedactorSchema',
	],
	'@agent-vm/agent-portal-sdk/capability-description-surface': [
		'CapabilitySearchMatchSchema',
		'CapabilityDescriptorSchema',
		'CapabilitySummarySchema',
		'ResultExpectationSchema',
		'SafeCallingHintSchema',
		'ToolSafetySummarySchema',
		'ToolSchemaHintSchema',
		'ToolSchemaSummarySchema',
	],
	'@agent-vm/agent-portal-sdk/contracts': [
		'GatewayRuntimeFrameworkIdentitySchema',
		'GatewayRuntimeProjectionCohortDigestSchema',
		'GatewayRuntimeTrustedInvocationPrincipalSchema',
		'ManagedAgentProjectionSchema',
	],
	'@agent-vm/agent-portal-sdk/gateway-runtime-client': [
		'GatewayRuntimeClient',
		'GatewayRuntimeFrameDecoder',
		'GatewayRuntimeProtocolError',
		'GatewayRuntimeSocketReadFlow',
		'createGatewayRuntimeChunkSenderState',
		'createNodeGatewayRuntimeTransportFactory',
		'encodeGatewayRuntimeFrame',
		'reduceGatewayRuntimeChunkSenderState',
	],
	'@agent-vm/agent-portal-sdk/portal-call-surface': [
		'PortalCallRequestSchema',
		'PortalCallResultSchema',
		'PortalDescribeResultSchema',
		'PortalDescribeRequestSchema',
		'PortalErrorSchema',
		'PortalListResultSchema',
		'PortalListRequestSchema',
		'PortalSearchResultSchema',
		'PortalSearchRequestSchema',
	],
	'@agent-vm/agent-portal-sdk/portal-event-surface': [
		'PortalCancellationRequestEventSchema',
		'PortalCancellationResultEventSchema',
		'PortalDiagnosticEventSchema',
		'PortalEventSchema',
		'PortalPartialOutputEventSchema',
		'PortalProgressEventSchema',
		'SafeDiagnosticSchema',
	],
	'@agent-vm/agent-portal-sdk/portable-contracts': [
		'PORTABLE_CONTRACT_ADAPTERS',
		'PORTABLE_REFINEMENT_DESCRIPTORS',
		'PORTABLE_REFINEMENT_IDENTITIES',
		'assertPortableContractSchemaIsExportable',
		'encodeCanonicalJson',
	],
	'@agent-vm/agent-portal-sdk/testing': [
		'createPortalCallRequestFixture',
		'createPortalCallResultFixture',
	],
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client': ['ToolPortalMcpClient'],
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport': [
		'createNodeToolPortalMcpTransport',
	],
	'@agent-vm/controller-execution-contracts': [
		'ArtifactPolicySchema',
		'CancellationPolicySchema',
		'CwdPolicySchema',
		'EgressPolicySchema',
		'EnvironmentPolicySchema',
		'ManagedVmExecRequestSchema',
		'OutputPolicySchema',
	],
	'@agent-vm/controller-execution-contracts/testing': [
		'createControllerDispatchIntentFixture',
		'createManagedVmExecRequestFixture',
	],
	'@agent-vm/control-protocol-contracts': [
		'CONTROL_HANDSHAKE_HEADER_NAMES',
		'CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE',
		'CONTROL_PROTOCOL_VERSION',
		'CONTROL_QUEUE_LIMITS',
		'CONTROL_READY_HEADER_NAMES',
		'CONTROL_SESSION_TIMING_MS',
		'ControlCorrelationSchema',
		'ControlEnvelopeSchema',
		'ControlHandshakeProofSchema',
		'ControlMessageKindSchema',
		'ControlReadyRequestProofSchema',
		'ControlRpcErrorSchema',
		'ControlSessionStateSchema',
		'assertControlEnvelopeMatchesDomainMessage',
		'assertControlMessageReceiptAccepted',
		'assertDerivedControlDeliveryPolicy',
		'buildControlHandshakeSignaturePayload',
		'buildControlMessageReceipt',
		'buildControlMessageRejectionReceipt',
		'buildControlProtocolJsonSchemas',
		'buildControlReadyRequestSignaturePayload',
		'evaluateControlSequenceContinuity',
		'extractDomainCommandResultResponseToMessageId',
	],
	'@agent-vm/gateway-control-contracts': [
		'GatewayControlDomainSchema',
		'GatewayControlRpcCommandResultMessageSchema',
		'GatewayControlRpcMessageSchema',
		'GatewayControlToolPortalControllerHostActionPayloadSchema',
		'GatewayRuntimePortalSemanticSnapshotSchema',
		'GatewayRuntimeTrustedInvocationContextSchema',
		'buildGatewayControlJsonSchemas',
		'createGatewayControlAdmissionScheduler',
		'createGatewayControlAdmissionExecutor',
		'createGatewayControlProcessAdmission',
		'gatewayControlCommandExecutionTimeoutMsByOperation',
		'gatewayControlDeliveryPolicyByKind',
		'gatewayControlDeliveryPolicyByOperation',
	],
	'@agent-vm/gateway-runtime': [
		'GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS',
		'createGatewayRuntimeToolPortalComposition',
	],
	'@agent-vm/mcp-portal': ['UpstreamMcpError', 'createUpstreamMcpClientRuntime'],
	'@agent-vm/mcp-portal/cli': ['buildProfilePolicyMaps'],
	'@agent-vm/mcp-portal/core': [
		'createPortalPolicyApprovalEvaluator',
		'createPortalCore',
		'createUpstreamMcpClientRuntime',
		'listPortalCoreToolDescriptors',
		'redactCredentialText',
		'resolveUpstreamServers',
	],
	'@agent-vm/mcp-portal/mcp-proxy': [
		'createPortalHttpAgentResolver',
		'createPortalHttpApp',
		'createPortalMcpServer',
	],
	'@agent-vm/mcp-portal/mcp-provider-backend': [
		'createManagedMcpProviderBackendFactory',
		'createMcpProviderCapabilityBackend',
	],
	'@agent-vm/mcp-portal/portal-config': ['generateTypescriptCatalogArtifact'],
	'@agent-vm/mcp-portal/portal-auth/agent-bearer-token': [
		'decodePortalMasterKey',
		'deriveAgentBearerToken',
		'verifyAgentBearerAuthorization',
	],
	'@agent-vm/mcp-portal/portal-auth/hmac-env': ['parseHmacKeysFromEnv', 'portalHmacKeyEnvName'],
	'@agent-vm/mcp-portal/portal-auth/hmac-token': [
		'hashCallArguments',
		'signApprovalToken',
		'verifyApprovalToken',
	],
	'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server': [
		'createFakeUpstreamTools',
		'startFakeUpstreamMcpServer',
	],
	'@agent-vm/tool-portal': ['createToolPortalMcpProviderBackendPort', 'createToolPortalService'],
	'@agent-vm/tool-portal/testing': ['createCliAllowanceFixture', 'createToolPortalConfigFixture'],
	'@agent-vm/worker-control-contracts': [
		'WorkerControlDomainSchema',
		'WorkerControlRpcCommandResultMessageSchema',
		'WorkerControlRpcMessageSchema',
		'WorkerControlRpcResponsePayloadSchema',
		'buildWorkerControlJsonSchemas',
		'workerControlCommandExecutionTimeoutMsByOperation',
		'workerControlDeliveryPolicyByOperation',
	],
} as const;

const requiredPortalNamedExportSpecifiers = [
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/agent-portal-sdk/adapter-boundary',
	'@agent-vm/agent-portal-sdk/approval-surface',
	'@agent-vm/agent-portal-sdk/artifact-surface',
	'@agent-vm/agent-portal-sdk/capability-description-surface',
	'@agent-vm/agent-portal-sdk/gateway-runtime-client',
	'@agent-vm/agent-portal-sdk/portal-call-surface',
	'@agent-vm/agent-portal-sdk/portal-event-surface',
	'@agent-vm/agent-portal-sdk/portable-contracts',
	'@agent-vm/agent-portal-sdk/testing',
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client',
	'@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/controller-execution-contracts/testing',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/gateway-runtime',
	'@agent-vm/mcp-portal',
	'@agent-vm/mcp-portal/cli',
	'@agent-vm/mcp-portal/core',
	'@agent-vm/mcp-portal/mcp-proxy',
	'@agent-vm/mcp-portal/mcp-provider-backend',
	'@agent-vm/mcp-portal/portal-config',
	'@agent-vm/mcp-portal/portal-auth/agent-bearer-token',
	'@agent-vm/mcp-portal/portal-auth/hmac-env',
	'@agent-vm/mcp-portal/portal-auth/hmac-token',
	'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server',
	'@agent-vm/tool-portal',
	'@agent-vm/tool-portal/testing',
	'@agent-vm/worker-control-contracts',
] as const satisfies readonly (keyof typeof requiredPortalNamedExports)[];

const requiredPortalExportSmokeCalls = {
	'@agent-vm/controller-execution-contracts/testing': [
		'createControllerDispatchIntentFixture',
		'createManagedVmExecRequestFixture',
	],
} as const;

const requiredPortalExportSmokeSpecifiers = [
	'@agent-vm/controller-execution-contracts/testing',
] as const satisfies readonly (keyof typeof requiredPortalExportSmokeCalls)[];

const deferredPortalPackageExports = [
	'@agent-vm/openclaw-tool-portal-plugin',
	'@agent-vm/tool-portal/cli',
	'@agent-vm/tool-portal/http-api',
	'@agent-vm/tool-portal/mcp-proxy',
] as const;

const forbiddenPortalPackageExports = [
	'@agent-vm/gateway-runtime/flow-control',
	'@agent-vm/gateway-runtime/protocol',
	'@agent-vm/tool-portal/in-process-entrypoint',
] as const;

const forbiddenPortalNamedExports = {
	'@agent-vm/tool-portal': [
		'createManagedToolPortalInProcessRuntime',
		'createToolPortalInProcessEntryPoint',
	],
} as const;

const forbiddenPortalNamedExportSpecifiers = [
	'@agent-vm/tool-portal',
] as const satisfies readonly (keyof typeof forbiddenPortalNamedExports)[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isZeroArgumentFunction(value: unknown): value is () => unknown {
	return typeof value === 'function';
}

function packageNameAndSubpathForSpecifier(specifier: string): {
	readonly packageName: string;
	readonly subpath: string;
} {
	const match = /^@agent-vm\/([^/]+)(?:\/(.+))?$/u.exec(specifier);
	if (match?.[1] === undefined) {
		throw new Error(`Portal export ${specifier} is not an @agent-vm package specifier`);
	}
	return {
		packageName: match[1],
		subpath: match[2] ?? '',
	};
}

function packageExportKeyForSubpath(subpath: string): string {
	return subpath.length === 0 ? '.' : `./${subpath}`;
}

function exportImportPathFromValue(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (isRecord(value) && typeof value.import === 'string') {
		return value.import;
	}
	return undefined;
}

function exportTypesPathFromValue(value: unknown): string | undefined {
	if (isRecord(value) && typeof value.types === 'string') {
		return value.types;
	}
	return undefined;
}

async function loadPackageJson(packageName: string): Promise<Readonly<Record<string, unknown>>> {
	const packageJsonPath = path.join(repositoryRoot, 'packages', packageName, 'package.json');
	const parsedPackageJson: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));
	if (!isRecord(parsedPackageJson)) {
		throw new Error(`packages/${packageName}/package.json did not parse as an object`);
	}
	return parsedPackageJson;
}

async function requiredPackageExportTargetsForSpecifier(specifier: string): Promise<{
	readonly importUrl: string;
	readonly typesPath: string;
}> {
	const { packageName, subpath } = packageNameAndSubpathForSpecifier(specifier);
	const packageJson = await loadPackageJson(packageName);
	if (!isRecord(packageJson.exports)) {
		throw new Error(`Portal export ${specifier} package has no exports map`);
	}
	const exportKey = packageExportKeyForSubpath(subpath);
	const exportValue = packageJson.exports[exportKey];
	if (exportValue === undefined) {
		throw new Error(`Portal export ${specifier} is missing package export ${exportKey}`);
	}
	const importPath = exportImportPathFromValue(exportValue);
	if (importPath === undefined) {
		throw new Error(`Portal export ${specifier} has no import target in package exports`);
	}
	if (!importPath.startsWith('./dist/') || !importPath.endsWith('.js')) {
		throw new Error(
			`Portal export ${specifier} import target ${importPath} is not a built dist JavaScript export`,
		);
	}
	const typesPath = exportTypesPathFromValue(exportValue);
	if (typesPath === undefined) {
		throw new Error(`Portal export ${specifier} has no types target in package exports`);
	}
	if (!typesPath.startsWith('./dist/') || !typesPath.endsWith('.d.ts')) {
		throw new Error(
			`Portal export ${specifier} types target ${typesPath} is not a built dist declaration export`,
		);
	}
	const packageRootPath = path.resolve(repositoryRoot, 'packages', packageName);
	const resolvedTypesPath = path.resolve(packageRootPath, typesPath);
	const relativeTypesPath = path.relative(packageRootPath, resolvedTypesPath);
	if (relativeTypesPath.startsWith('..') || path.isAbsolute(relativeTypesPath)) {
		throw new Error(`Portal export ${specifier} types target escapes its package root`);
	}
	const typesFileStats = await stat(resolvedTypesPath);
	if (!typesFileStats.isFile()) {
		throw new Error(`Portal export ${specifier} types target is not a regular file: ${typesPath}`);
	}
	return {
		importUrl: pathToFileURL(path.resolve(packageRootPath, importPath)).href,
		typesPath,
	};
}

async function importRequiredPackageExport(
	specifier: string,
): Promise<Readonly<Record<string, unknown>>> {
	const moduleExports: unknown = await import(
		(await requiredPackageExportTargetsForSpecifier(specifier)).importUrl
	);
	if (!isRecord(moduleExports)) {
		throw new Error(`Portal export ${specifier} did not load a module namespace object`);
	}
	return moduleExports;
}

async function assertAgentPortalSdkRootTypesMatchPackageTypes(): Promise<void> {
	const packageJson = await loadPackageJson('agent-portal-sdk');
	if (!isRecord(packageJson.exports)) {
		throw new Error('Agent Portal SDK package has no exports map');
	}
	const rootTypesPath = exportTypesPathFromValue(packageJson.exports['.']);
	if (rootTypesPath === undefined || packageJson.types !== rootTypesPath) {
		throw new Error(
			'Agent Portal SDK package types field must match the root package export types target',
		);
	}
}

function assertBuiltDeclarationConsumerCompiles(): void {
	const configPath = path.join(
		repositoryRoot,
		'packages',
		'agent-portal-sdk',
		'type-tests',
		'built-declaration-consumer',
		'tsconfig.json',
	);
	const configFile = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
	const diagnostics: ts.Diagnostic[] = [];
	if (configFile.error !== undefined) {
		diagnostics.push(configFile.error);
	} else {
		const parsedConfig = ts.parseJsonConfigFileContent(
			configFile.config,
			ts.sys,
			path.dirname(configPath),
			undefined,
			configPath,
		);
		diagnostics.push(...parsedConfig.errors);
		if (parsedConfig.errors.length === 0) {
			const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
			diagnostics.push(...ts.getPreEmitDiagnostics(program));
		}
	}
	if (diagnostics.length === 0) {
		return;
	}
	throw new Error(
		`Built Agent Portal SDK declaration consumer failed to compile:\n${ts.formatDiagnostics(
			diagnostics,
			{
				getCanonicalFileName: (fileName) => fileName,
				getCurrentDirectory: () => repositoryRoot,
				getNewLine: () => '\n',
			},
		)}`,
	);
}

async function assertRequiredExportResolves(specifier: string): Promise<void> {
	await importRequiredPackageExport(specifier);
}

async function assertRequiredNamedExportsResolve(
	specifier: keyof typeof requiredPortalNamedExports,
): Promise<number> {
	const moduleExports = await importRequiredPackageExport(specifier);
	const missingNames = requiredPortalNamedExports[specifier].filter(
		(exportName) => !Object.hasOwn(moduleExports, exportName),
	);
	if (missingNames.length > 0) {
		throw new Error(
			`Portal export ${specifier} is missing named exports: ${missingNames.join(', ')}`,
		);
	}
	return requiredPortalNamedExports[specifier].length;
}

async function assertForbiddenNamedExportsAreAbsent(
	specifier: keyof typeof forbiddenPortalNamedExports,
): Promise<number> {
	const moduleExports = await importRequiredPackageExport(specifier);
	const presentNames = forbiddenPortalNamedExports[specifier].filter((exportName) =>
		Object.hasOwn(moduleExports, exportName),
	);
	if (presentNames.length > 0) {
		throw new Error(
			`Portal export ${specifier} retains forbidden named exports: ${presentNames.join(', ')}`,
		);
	}
	return forbiddenPortalNamedExports[specifier].length;
}

async function assertRequiredExportSmokeCallsPass(
	specifier: keyof typeof requiredPortalExportSmokeCalls,
): Promise<number> {
	const moduleExports = await importRequiredPackageExport(specifier);
	for (const exportName of requiredPortalExportSmokeCalls[specifier]) {
		const exportedValue = moduleExports[exportName];
		if (!isZeroArgumentFunction(exportedValue)) {
			throw new Error(`Portal export ${specifier}.${exportName} is not callable`);
		}
		const result = exportedValue();
		if (result === undefined) {
			throw new Error(`Portal export ${specifier}.${exportName} returned undefined`);
		}
	}
	return requiredPortalExportSmokeCalls[specifier].length;
}

async function assertDeferredExportIsAbsent(specifier: string): Promise<void> {
	const { packageName, subpath } = packageNameAndSubpathForSpecifier(specifier);
	let packageJson: Readonly<Record<string, unknown>>;
	try {
		packageJson = await loadPackageJson(packageName);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	if (!isRecord(packageJson.exports)) {
		return;
	}
	if (packageJson.exports[packageExportKeyForSubpath(subpath)] === undefined) {
		return;
	}
	throw new Error(`Deferred portal export unexpectedly resolved: ${specifier}`);
}

async function main(): Promise<void> {
	await Promise.all(
		requiredPortalPackageExports.map((specifier) => assertRequiredExportResolves(specifier)),
	);
	const namedExportCounts = await Promise.all(
		requiredPortalNamedExportSpecifiers.map((specifier) =>
			assertRequiredNamedExportsResolve(specifier),
		),
	);
	const namedExportCount = namedExportCounts.reduce(
		(totalCount, exportCount) => totalCount + exportCount,
		0,
	);
	const forbiddenNamedExportCounts = await Promise.all(
		forbiddenPortalNamedExportSpecifiers.map((specifier) =>
			assertForbiddenNamedExportsAreAbsent(specifier),
		),
	);
	const forbiddenNamedExportCount = forbiddenNamedExportCounts.reduce(
		(totalCount, exportCount) => totalCount + exportCount,
		0,
	);
	const smokeCallCounts = await Promise.all(
		requiredPortalExportSmokeSpecifiers.map((specifier) =>
			assertRequiredExportSmokeCallsPass(specifier),
		),
	);
	const smokeCallCount = smokeCallCounts.reduce(
		(totalCount, smokeCallCountForSpecifier) => totalCount + smokeCallCountForSpecifier,
		0,
	);
	await Promise.all(
		deferredPortalPackageExports.map((specifier) => assertDeferredExportIsAbsent(specifier)),
	);
	await Promise.all(
		forbiddenPortalPackageExports.map((specifier) => assertDeferredExportIsAbsent(specifier)),
	);
	await assertAgentPortalSdkRootTypesMatchPackageTypes();
	assertBuiltDeclarationConsumerCompiles();
	process.stdout.write(
		`portal package exports: ${String(requiredPortalPackageExports.length)} required imports and declaration targets resolved, ${String(namedExportCount)} named exports present, ${String(forbiddenNamedExportCount)} forbidden named exports absent, ${String(smokeCallCount)} smoke calls passed, built declaration consumer compiled, ${String(deferredPortalPackageExports.length)} deferred imports absent, ${String(forbiddenPortalPackageExports.length)} forbidden compatibility imports absent\n`,
	);
}

await main();
