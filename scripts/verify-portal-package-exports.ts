const requiredPortalPackageExports = [
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/agent-portal-sdk/adapter-boundary',
	'@agent-vm/agent-portal-sdk/approval-surface',
	'@agent-vm/agent-portal-sdk/artifact-surface',
	'@agent-vm/agent-portal-sdk/capability-description-surface',
	'@agent-vm/agent-portal-sdk/portal-call-surface',
	'@agent-vm/agent-portal-sdk/portal-event-surface',
	'@agent-vm/agent-portal-sdk/testing',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/controller-execution-contracts/controller-dispatch-boundary',
	'@agent-vm/controller-execution-contracts/controller-host-action-boundary',
	'@agent-vm/controller-execution-contracts/credentialed-runner-boundary',
	'@agent-vm/controller-execution-contracts/testing',
	'@agent-vm/mcp-portal/mcp-provider-backend',
	'@agent-vm/tool-portal',
	'@agent-vm/tool-portal/in-process-entrypoint',
	'@agent-vm/tool-portal/testing',
] as const;

const requiredPortalNamedExports = {
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
		'CapabilityDescriptorSchema',
		'CapabilitySummarySchema',
		'ResultExpectationSchema',
		'SafeCallingHintSchema',
	],
	'@agent-vm/agent-portal-sdk/portal-call-surface': [
		'PortalCallRequestSchema',
		'PortalCallResultSchema',
		'PortalDescribeRequestSchema',
		'PortalErrorSchema',
		'PortalListRequestSchema',
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
	'@agent-vm/agent-portal-sdk/testing': [
		'createPortalCallRequestFixture',
		'createPortalCallResultFixture',
	],
	'@agent-vm/controller-execution-contracts/testing': [
		'createControllerDispatchIntentFixture',
		'createCredentialedRunnerRequestFixture',
		'createManagedVmExecRequestFixture',
	],
	'@agent-vm/tool-portal/testing': ['createCliAllowanceFixture', 'createToolPortalConfigFixture'],
} as const;

const deferredPortalPackageExports = [
	'@agent-vm/openclaw-tool-portal-plugin',
	'@agent-vm/tool-portal/cli',
	'@agent-vm/tool-portal/http-api',
	'@agent-vm/tool-portal/mcp-proxy',
] as const;

async function assertRequiredExportResolves(specifier: string): Promise<void> {
	await import(specifier);
}

async function assertRequiredNamedExportsResolve(
	specifier: keyof typeof requiredPortalNamedExports,
): Promise<number> {
	const moduleExports = (await import(specifier)) as Readonly<Record<string, unknown>>;
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

async function assertDeferredExportIsAbsent(specifier: string): Promise<void> {
	try {
		await import(specifier);
	} catch {
		return;
	}
	throw new Error(`Deferred portal export unexpectedly resolved: ${specifier}`);
}

async function main(): Promise<void> {
	for (const specifier of requiredPortalPackageExports) {
		await assertRequiredExportResolves(specifier);
	}
	let namedExportCount = 0;
	for (const specifier of Object.keys(
		requiredPortalNamedExports,
	) as (keyof typeof requiredPortalNamedExports)[]) {
		namedExportCount += await assertRequiredNamedExportsResolve(specifier);
	}
	for (const specifier of deferredPortalPackageExports) {
		await assertDeferredExportIsAbsent(specifier);
	}
	process.stdout.write(
		`portal package exports: ${String(requiredPortalPackageExports.length)} required imports resolved, ${String(namedExportCount)} named exports present, ${String(deferredPortalPackageExports.length)} deferred imports absent\n`,
	);
}

await main();
