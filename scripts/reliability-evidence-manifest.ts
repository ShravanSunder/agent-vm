export const RELIABILITY_EVIDENCE_PROJECTS = [
	'taxonomy',
	'unit',
	'integration',
	'e2e-host',
	'e2e-host-docker',
	'e2e-vm',
	'e2e-vm-mediation',
	'e2e-openclaw',
	'e2e-worker',
] as const;

export type ReliabilityEvidenceProject = (typeof RELIABILITY_EVIDENCE_PROJECTS)[number];

export interface ReliabilityEvidenceArtifactIdentity {
	readonly operationId: string;
	readonly sha256: string;
}

export interface ReliabilityEvidencePackageIdentity {
	readonly checksumSha256: string;
	readonly name: string;
	readonly version: string;
}

export interface ReliabilityEvidenceRuntimeIdentity {
	readonly generation: number;
	readonly id: string;
	readonly kind: string;
}

export interface ReliabilityEvidenceProcessIdentity {
	readonly bootId: string;
	readonly kind: string;
	readonly processId: number;
	readonly startIdentity: string;
}

export interface ReliabilityEvidenceGenerationIdentity {
	readonly generation: number;
	readonly targetId: string;
	readonly targetKind: string;
}

export interface ReliabilityEvidenceQueryIdentity {
	readonly marker: string;
	readonly source: string;
	readonly windowEndMs: number;
	readonly windowStartMs: number;
}

export interface ReliabilityEvidenceReceipt {
	readonly artifacts: readonly ReliabilityEvidenceArtifactIdentity[];
	readonly dirtyHash: string;
	readonly exitCode: number;
	readonly failedTests: number;
	readonly fileCount: number;
	readonly generationIdentities?: readonly ReliabilityEvidenceGenerationIdentity[] | undefined;
	readonly headSha: string;
	readonly operationId: string;
	readonly packageIdentities: readonly ReliabilityEvidencePackageIdentity[];
	readonly passedTests: number;
	readonly processIdentities?: readonly ReliabilityEvidenceProcessIdentity[] | undefined;
	readonly project: ReliabilityEvidenceProject;
	readonly queryIdentities?: readonly ReliabilityEvidenceQueryIdentity[] | undefined;
	readonly receiptId: string;
	readonly runId: string;
	readonly runtimeIdentities?: readonly ReliabilityEvidenceRuntimeIdentity[] | undefined;
	readonly schemaVersion: 1;
	readonly skippedTests: number;
	readonly todoTests: number;
	readonly totalTests: number;
}

export interface ReliabilityEvidenceManifest {
	readonly createdAtMs: number;
	readonly dirtyHash: string;
	readonly headSha: string;
	readonly receipts: readonly ReliabilityEvidenceReceipt[];
	readonly runId: string;
	readonly schemaVersion: 1;
}

export interface ReliabilityScenarioEvidence {
	readonly artifacts: readonly ReliabilityEvidenceArtifactIdentity[];
	readonly dirtyHash: string;
	readonly generationIdentities: readonly ReliabilityEvidenceGenerationIdentity[];
	readonly headSha: string;
	readonly operationId: string;
	readonly packageIdentities: readonly ReliabilityEvidencePackageIdentity[];
	readonly processIdentities: readonly ReliabilityEvidenceProcessIdentity[];
	readonly queryIdentities?: readonly ReliabilityEvidenceQueryIdentity[] | undefined;
	readonly runId: string;
	readonly runtimeIdentities: readonly ReliabilityEvidenceRuntimeIdentity[];
	readonly schemaVersion: 1;
}

interface StrictSchemaParseSuccess<TValue> {
	readonly data: TValue;
	readonly success: true;
}

interface StrictSchemaParseFailure {
	readonly error: Error;
	readonly success: false;
}

interface StrictRuntimeSchema<TValue> {
	parse(input: unknown): TValue;
	safeParse(input: unknown): StrictSchemaParseSuccess<TValue> | StrictSchemaParseFailure;
}

export interface ReliabilityEvidenceProjectExpectation {
	readonly operationId: string;
	readonly project: ReliabilityEvidenceProject;
	readonly requireGenerationIdentity?: boolean;
	readonly requireProcessIdentity?: boolean;
	readonly requireQueryIdentity?: boolean;
	readonly requireRuntimeIdentity?: boolean;
}

export interface ReliabilityEvidenceValidationResult {
	readonly findings: readonly string[];
	readonly ok: boolean;
}

export interface ReliabilityEvidenceValidationOptions {
	readonly leakCanaries?: readonly string[];
	readonly maxQueryAgeMs?: number;
	readonly nowMs?: number;
}

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

function createStrictRuntimeSchema<TValue>(
	parser: (input: unknown) => TValue,
): StrictRuntimeSchema<TValue> {
	return {
		parse: parser,
		safeParse(input: unknown): StrictSchemaParseSuccess<TValue> | StrictSchemaParseFailure {
			try {
				return { data: parser(input), success: true };
			} catch (error) {
				return {
					error: error instanceof Error ? error : new Error(String(error)),
					success: false,
				};
			}
		},
	};
}

function parseRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error(`${label} must be an object.`);
	}
	return input;
}

function assertExactKeys(
	record: Readonly<Record<string, unknown>>,
	allowedKeys: readonly string[],
	label: string,
): void {
	const allowedKeySet = new Set(allowedKeys);
	const unknownKeys = Object.keys(record).filter((key) => !allowedKeySet.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${label} contains unknown field ${unknownKeys[0]}.`);
	}
}

function parseBoundedString(
	input: unknown,
	label: string,
	options: { readonly maxLength: number; readonly pattern?: RegExp },
): string {
	if (
		typeof input !== 'string' ||
		input.length === 0 ||
		input.length > options.maxLength ||
		input.includes('\0') ||
		(options.pattern !== undefined && !options.pattern.test(input))
	) {
		throw new Error(`${label} is invalid or exceeds its bound.`);
	}
	return input;
}

function parseInteger(
	input: unknown,
	label: string,
	options: { readonly maximum?: number; readonly minimum: number },
): number {
	if (
		typeof input !== 'number' ||
		!Number.isSafeInteger(input) ||
		input < options.minimum ||
		(options.maximum !== undefined && input > options.maximum)
	) {
		throw new Error(`${label} must be a safe integer within bounds.`);
	}
	return input;
}

function parseArray<TValue>(
	input: unknown,
	label: string,
	options: { readonly maximum: number; readonly minimum: number },
	parseItem: (value: unknown, itemLabel: string) => TValue,
): readonly TValue[] {
	if (!Array.isArray(input) || input.length < options.minimum || input.length > options.maximum) {
		throw new Error(`${label} must contain ${options.minimum}-${options.maximum} entries.`);
	}
	return input.map((value, index) => parseItem(value, `${label}[${index}]`));
}

function parseProject(input: unknown, label: string): ReliabilityEvidenceProject {
	switch (input) {
		case 'taxonomy':
		case 'unit':
		case 'integration':
		case 'e2e-host':
		case 'e2e-host-docker':
		case 'e2e-vm':
		case 'e2e-vm-mediation':
		case 'e2e-openclaw':
		case 'e2e-worker':
			return input;
		default:
			throw new Error(`${label} is not a reliability evidence project.`);
	}
}

function parseArtifactIdentity(input: unknown, label: string): ReliabilityEvidenceArtifactIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['operationId', 'sha256'], label);
	return {
		operationId: parseBoundedString(record.operationId, `${label}.operationId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		sha256: parseBoundedString(record.sha256, `${label}.sha256`, {
			maxLength: 64,
			pattern: SHA256_PATTERN,
		}),
	};
}

function parsePackageIdentity(input: unknown, label: string): ReliabilityEvidencePackageIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['checksumSha256', 'name', 'version'], label);
	return {
		checksumSha256: parseBoundedString(record.checksumSha256, `${label}.checksumSha256`, {
			maxLength: 64,
			pattern: SHA256_PATTERN,
		}),
		name: parseBoundedString(record.name, `${label}.name`, { maxLength: 128 }),
		version: parseBoundedString(record.version, `${label}.version`, { maxLength: 64 }),
	};
}

function parseRuntimeIdentity(input: unknown, label: string): ReliabilityEvidenceRuntimeIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['generation', 'id', 'kind'], label);
	return {
		generation: parseInteger(record.generation, `${label}.generation`, { minimum: 0 }),
		id: parseBoundedString(record.id, `${label}.id`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		kind: parseBoundedString(record.kind, `${label}.kind`, {
			maxLength: 64,
			pattern: SAFE_ID_PATTERN,
		}),
	};
}

function parseProcessIdentity(input: unknown, label: string): ReliabilityEvidenceProcessIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['bootId', 'kind', 'processId', 'startIdentity'], label);
	return {
		bootId: parseBoundedString(record.bootId, `${label}.bootId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		kind: parseBoundedString(record.kind, `${label}.kind`, {
			maxLength: 64,
			pattern: SAFE_ID_PATTERN,
		}),
		processId: parseInteger(record.processId, `${label}.processId`, { minimum: 1 }),
		startIdentity: parseBoundedString(record.startIdentity, `${label}.startIdentity`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
	};
}

function parseGenerationIdentity(
	input: unknown,
	label: string,
): ReliabilityEvidenceGenerationIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['generation', 'targetId', 'targetKind'], label);
	return {
		generation: parseInteger(record.generation, `${label}.generation`, { minimum: 0 }),
		targetId: parseBoundedString(record.targetId, `${label}.targetId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		targetKind: parseBoundedString(record.targetKind, `${label}.targetKind`, {
			maxLength: 64,
			pattern: SAFE_ID_PATTERN,
		}),
	};
}

function parseQueryIdentity(input: unknown, label: string): ReliabilityEvidenceQueryIdentity {
	const record = parseRecord(input, label);
	assertExactKeys(record, ['marker', 'source', 'windowEndMs', 'windowStartMs'], label);
	const windowStartMs = parseInteger(record.windowStartMs, `${label}.windowStartMs`, {
		minimum: 0,
	});
	const windowEndMs = parseInteger(record.windowEndMs, `${label}.windowEndMs`, { minimum: 0 });
	if (windowEndMs < windowStartMs) {
		throw new Error(`${label} has an inverted query window.`);
	}
	return {
		marker: parseBoundedString(record.marker, `${label}.marker`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		source: parseBoundedString(record.source, `${label}.source`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		windowEndMs,
		windowStartMs,
	};
}

function parseOptionalIdentityArray<TValue>(
	input: unknown,
	label: string,
	parseItem: (value: unknown, itemLabel: string) => TValue,
): readonly TValue[] | undefined {
	return input === undefined
		? undefined
		: parseArray(input, label, { maximum: 64, minimum: 1 }, parseItem);
}

function parseReceipt(input: unknown, label: string): ReliabilityEvidenceReceipt {
	const record = parseRecord(input, label);
	assertExactKeys(
		record,
		[
			'artifacts',
			'dirtyHash',
			'exitCode',
			'failedTests',
			'fileCount',
			'generationIdentities',
			'headSha',
			'operationId',
			'packageIdentities',
			'passedTests',
			'processIdentities',
			'project',
			'queryIdentities',
			'receiptId',
			'runId',
			'runtimeIdentities',
			'schemaVersion',
			'skippedTests',
			'todoTests',
			'totalTests',
		],
		label,
	);
	if (record.schemaVersion !== 1) {
		throw new Error(`${label}.schemaVersion must be 1.`);
	}
	return {
		artifacts: parseArray(
			record.artifacts,
			`${label}.artifacts`,
			{ maximum: 64, minimum: 1 },
			parseArtifactIdentity,
		),
		dirtyHash: parseBoundedString(record.dirtyHash, `${label}.dirtyHash`, {
			maxLength: 64,
			pattern: SHA256_PATTERN,
		}),
		exitCode: parseInteger(record.exitCode, `${label}.exitCode`, { minimum: 0 }),
		failedTests: parseInteger(record.failedTests, `${label}.failedTests`, { minimum: 0 }),
		fileCount: parseInteger(record.fileCount, `${label}.fileCount`, { minimum: 0 }),
		generationIdentities: parseOptionalIdentityArray(
			record.generationIdentities,
			`${label}.generationIdentities`,
			parseGenerationIdentity,
		),
		headSha: parseBoundedString(record.headSha, `${label}.headSha`, {
			maxLength: 40,
			pattern: SHA1_PATTERN,
		}),
		operationId: parseBoundedString(record.operationId, `${label}.operationId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		packageIdentities: parseArray(
			record.packageIdentities,
			`${label}.packageIdentities`,
			{ maximum: 64, minimum: 1 },
			parsePackageIdentity,
		),
		passedTests: parseInteger(record.passedTests, `${label}.passedTests`, { minimum: 0 }),
		processIdentities: parseOptionalIdentityArray(
			record.processIdentities,
			`${label}.processIdentities`,
			parseProcessIdentity,
		),
		project: parseProject(record.project, `${label}.project`),
		queryIdentities: parseOptionalIdentityArray(
			record.queryIdentities,
			`${label}.queryIdentities`,
			parseQueryIdentity,
		),
		receiptId: parseBoundedString(record.receiptId, `${label}.receiptId`, {
			maxLength: 36,
			pattern: UUID_PATTERN,
		}),
		runId: parseBoundedString(record.runId, `${label}.runId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		runtimeIdentities: parseOptionalIdentityArray(
			record.runtimeIdentities,
			`${label}.runtimeIdentities`,
			parseRuntimeIdentity,
		),
		schemaVersion: 1,
		skippedTests: parseInteger(record.skippedTests, `${label}.skippedTests`, { minimum: 0 }),
		todoTests: parseInteger(record.todoTests, `${label}.todoTests`, { minimum: 0 }),
		totalTests: parseInteger(record.totalTests, `${label}.totalTests`, { minimum: 0 }),
	};
}

function parseScenarioEvidence(input: unknown): ReliabilityScenarioEvidence {
	const label = 'Reliability scenario evidence';
	const record = parseRecord(input, label);
	assertExactKeys(
		record,
		[
			'artifacts',
			'dirtyHash',
			'generationIdentities',
			'headSha',
			'operationId',
			'packageIdentities',
			'processIdentities',
			'queryIdentities',
			'runId',
			'runtimeIdentities',
			'schemaVersion',
		],
		label,
	);
	if (record.schemaVersion !== 1) {
		throw new Error(`${label}.schemaVersion must be 1.`);
	}
	return {
		artifacts: parseArray(
			record.artifacts,
			`${label}.artifacts`,
			{ maximum: 64, minimum: 1 },
			parseArtifactIdentity,
		),
		dirtyHash: parseBoundedString(record.dirtyHash, `${label}.dirtyHash`, {
			maxLength: 64,
			pattern: SHA256_PATTERN,
		}),
		generationIdentities: parseArray(
			record.generationIdentities,
			`${label}.generationIdentities`,
			{ maximum: 64, minimum: 1 },
			parseGenerationIdentity,
		),
		headSha: parseBoundedString(record.headSha, `${label}.headSha`, {
			maxLength: 40,
			pattern: SHA1_PATTERN,
		}),
		operationId: parseBoundedString(record.operationId, `${label}.operationId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		packageIdentities: parseArray(
			record.packageIdentities,
			`${label}.packageIdentities`,
			{ maximum: 64, minimum: 1 },
			parsePackageIdentity,
		),
		processIdentities: parseArray(
			record.processIdentities,
			`${label}.processIdentities`,
			{ maximum: 64, minimum: 1 },
			parseProcessIdentity,
		),
		queryIdentities: parseOptionalIdentityArray(
			record.queryIdentities,
			`${label}.queryIdentities`,
			parseQueryIdentity,
		),
		runId: parseBoundedString(record.runId, `${label}.runId`, {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		runtimeIdentities: parseArray(
			record.runtimeIdentities,
			`${label}.runtimeIdentities`,
			{ maximum: 64, minimum: 1 },
			parseRuntimeIdentity,
		),
		schemaVersion: 1,
	};
}

function parseManifest(input: unknown): ReliabilityEvidenceManifest {
	const record = parseRecord(input, 'Reliability evidence manifest');
	assertExactKeys(
		record,
		['createdAtMs', 'dirtyHash', 'headSha', 'receipts', 'runId', 'schemaVersion'],
		'Reliability evidence manifest',
	);
	if (record.schemaVersion !== 1) {
		throw new Error('Reliability evidence manifest schemaVersion must be 1.');
	}
	return {
		createdAtMs: parseInteger(record.createdAtMs, 'Reliability evidence manifest.createdAtMs', {
			minimum: 0,
		}),
		dirtyHash: parseBoundedString(record.dirtyHash, 'Reliability evidence manifest.dirtyHash', {
			maxLength: 64,
			pattern: SHA256_PATTERN,
		}),
		headSha: parseBoundedString(record.headSha, 'Reliability evidence manifest.headSha', {
			maxLength: 40,
			pattern: SHA1_PATTERN,
		}),
		receipts: parseArray(
			record.receipts,
			'Reliability evidence manifest.receipts',
			{ maximum: 64, minimum: 1 },
			parseReceipt,
		),
		runId: parseBoundedString(record.runId, 'Reliability evidence manifest.runId', {
			maxLength: 128,
			pattern: SAFE_ID_PATTERN,
		}),
		schemaVersion: 1,
	};
}

export const reliabilityEvidenceManifestSchema = createStrictRuntimeSchema(parseManifest);
export const reliabilityScenarioEvidenceSchema = createStrictRuntimeSchema(parseScenarioEvidence);

export function validateReliabilityEvidenceManifest(
	input: unknown,
	expectations: readonly ReliabilityEvidenceProjectExpectation[],
	options: ReliabilityEvidenceValidationOptions = {},
): ReliabilityEvidenceValidationResult {
	const serializedInput = JSON.stringify(input);
	const leakFindings = (options.leakCanaries ?? [])
		.filter((canary) => canary.length > 0 && serializedInput.includes(canary))
		.map(() => 'manifest contains a leak canary');
	const parsed = reliabilityEvidenceManifestSchema.safeParse(input);
	if (!parsed.success) {
		return {
			findings: [...leakFindings, `manifest parse failed: ${parsed.error.message}`],
			ok: false,
		};
	}

	const manifest = parsed.data;
	const findings: string[] = [...leakFindings];
	const seenReceiptIds = new Set<string>();
	const seenOperationIds = new Set<string>();
	for (const receipt of manifest.receipts) {
		if (seenReceiptIds.has(receipt.receiptId)) {
			findings.push(`duplicate receipt id ${receipt.receiptId}`);
		}
		seenReceiptIds.add(receipt.receiptId);
		if (seenOperationIds.has(receipt.operationId)) {
			findings.push(`duplicate operation receipt ${receipt.operationId}`);
		}
		seenOperationIds.add(receipt.operationId);
		if (receipt.runId !== manifest.runId) {
			findings.push(`${receipt.project}: wrong run identity`);
		}
		if (receipt.headSha !== manifest.headSha) {
			findings.push(`${receipt.project}: wrong head identity`);
		}
		if (receipt.dirtyHash !== manifest.dirtyHash) {
			findings.push(`${receipt.project}: wrong dirty-state identity`);
		}
		if (receipt.exitCode !== 0) {
			findings.push(`${receipt.project}: nonzero exit code`);
		}
		if (receipt.fileCount === 0) {
			findings.push(`${receipt.project}: zero files`);
		}
		if (receipt.totalTests === 0) {
			findings.push(`${receipt.project}: zero tests`);
		}
		if (receipt.failedTests > 0) {
			findings.push(`${receipt.project}: failed tests present`);
		}
		if (receipt.skippedTests > 0) {
			findings.push(`${receipt.project}: skipped tests present`);
		}
		if (receipt.todoTests > 0) {
			findings.push(`${receipt.project}: todo tests present`);
		}
		if (
			receipt.passedTests + receipt.failedTests + receipt.skippedTests + receipt.todoTests !==
			receipt.totalTests
		) {
			findings.push(`${receipt.project}: test count mismatch`);
		}
		for (const queryIdentity of receipt.queryIdentities ?? []) {
			const nowMs = options.nowMs ?? manifest.createdAtMs;
			const maxQueryAgeMs = options.maxQueryAgeMs ?? 15 * 60_000;
			if (
				queryIdentity.windowStartMs < nowMs - maxQueryAgeMs ||
				queryIdentity.windowEndMs > nowMs
			) {
				findings.push(`${receipt.operationId}: stale query window`);
			}
		}
	}

	const seenExpectedOperations = new Set<string>();
	for (const expectation of expectations) {
		if (seenExpectedOperations.has(expectation.operationId)) {
			findings.push(`duplicate operation expectation ${expectation.operationId}`);
		}
		seenExpectedOperations.add(expectation.operationId);
		const receipt = manifest.receipts.find(
			(candidate) => candidate.operationId === expectation.operationId,
		);
		if (receipt === undefined) {
			findings.push(`missing expected operation ${expectation.operationId}`);
			continue;
		}
		if (receipt.project !== expectation.project) {
			findings.push(`${expectation.operationId}: wrong project identity`);
		}
		if (expectation.requireRuntimeIdentity === true && receipt.runtimeIdentities === undefined) {
			findings.push(`${expectation.project}: missing runtime identity`);
		}
		if (expectation.requireProcessIdentity === true && receipt.processIdentities === undefined) {
			findings.push(`${expectation.project}: missing process identity`);
		}
		if (
			expectation.requireGenerationIdentity === true &&
			receipt.generationIdentities === undefined
		) {
			findings.push(`${expectation.project}: missing generation identity`);
		}
		if (expectation.requireQueryIdentity === true && receipt.queryIdentities === undefined) {
			findings.push(`${expectation.project}: missing query identity`);
		}
	}

	return { findings, ok: findings.length === 0 };
}
