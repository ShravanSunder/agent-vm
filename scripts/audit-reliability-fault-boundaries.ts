import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTROL_LEASE_RELIABILITY_SCENARIOS } from './control-lease-reliability-scenarios.js';

export interface ReliabilityFaultAuditSource {
	readonly content: string;
	readonly filePath: string;
}

export interface ReliabilityFaultAuditFinding {
	readonly filePath: string;
	readonly line: number;
	readonly reason: string;
}

interface ReliabilityFaultPattern {
	readonly pattern: RegExp;
	readonly reason: string;
	readonly scope: 'production' | 'proof';
}

const AUDIT_SOURCE_ROOTS = [
	'packages/agent-vm/src',
	'packages/openclaw-agent-vm-plugin/src',
] as const;
const RELIABILITY_PROOF_FILE_NAMES = new Set(
	CONTROL_LEASE_RELIABILITY_SCENARIOS.map(({ testFile }) => path.basename(testFile)),
);

const RELIABILITY_FAULT_PATTERNS: readonly ReliabilityFaultPattern[] = [
	{
		pattern: /\bssh-command-reset\b/u,
		reason: 'raw SSH reset fault',
		scope: 'proof',
	},
	{
		pattern: /\b(?:process\.kill\s*\([^,]+,\s*['"]SIGKILL['"]|kill\s+-(?:KILL|9)\b)/u,
		reason: 'raw process kill fault',
		scope: 'proof',
	},
	{ pattern: /\bkill\s+-STOP\b/u, reason: 'raw process stop fault', scope: 'proof' },
	{
		pattern: /\bexport\b.*\bcontroller\/reliability\/testing\b/u,
		reason: 'production export of reliability fault testing surface',
		scope: 'production',
	},
	{
		pattern:
			/\b(?:router|app)\.(?:delete|get|patch|post|put)\s*\(\s*['"][^'"]*(?:reliability-fault|fault-injection)[^'"]*['"]/u,
		reason: 'production reliability fault route',
		scope: 'production',
	},
];

function normalizeFilePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function isReliabilityTestingSource(filePath: string): boolean {
	return normalizeFilePath(filePath).includes('/controller/reliability/testing/');
}

function isProofSource(filePath: string): boolean {
	const normalizedPath = normalizeFilePath(filePath);
	return (
		normalizedPath.includes('/integration-tests/') &&
		RELIABILITY_PROOF_FILE_NAMES.has(path.basename(normalizedPath))
	);
}

function compareAuditFindings(
	left: ReliabilityFaultAuditFinding,
	right: ReliabilityFaultAuditFinding,
): number {
	const filePathOrder = left.filePath.localeCompare(right.filePath);
	if (filePathOrder !== 0) {
		return filePathOrder;
	}
	const lineOrder = left.line - right.line;
	return lineOrder === 0 ? left.reason.localeCompare(right.reason) : lineOrder;
}

function insertAuditFinding(
	findings: ReliabilityFaultAuditFinding[],
	finding: ReliabilityFaultAuditFinding,
): void {
	const insertionIndex = findings.findIndex(
		(candidate) => compareAuditFindings(finding, candidate) < 0,
	);
	if (insertionIndex < 0) {
		findings.push(finding);
		return;
	}
	findings.splice(insertionIndex, 0, finding);
}

export function auditReliabilityFaultBoundaries(
	sources: readonly ReliabilityFaultAuditSource[],
): readonly ReliabilityFaultAuditFinding[] {
	const findings: ReliabilityFaultAuditFinding[] = [];
	for (const source of sources) {
		if (isReliabilityTestingSource(source.filePath)) {
			continue;
		}
		const proofSource = isProofSource(source.filePath);
		for (const [lineIndex, line] of source.content.split('\n').entries()) {
			for (const faultPattern of RELIABILITY_FAULT_PATTERNS) {
				if (faultPattern.scope === 'proof' && !proofSource) {
					continue;
				}
				if (faultPattern.pattern.test(line)) {
					insertAuditFinding(findings, {
						filePath: normalizeFilePath(source.filePath),
						line: lineIndex + 1,
						reason: faultPattern.reason,
					});
				}
			}
		}
	}
	return findings;
}

async function listTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return listTypeScriptFiles(entryPath);
			}
			return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
		}),
	);
	return nestedFiles.flat();
}

export async function readReliabilityFaultAuditSources(
	repositoryRoot: string,
): Promise<readonly ReliabilityFaultAuditSource[]> {
	const sourceFiles = (
		await Promise.all(
			AUDIT_SOURCE_ROOTS.map((sourceRoot) =>
				listTypeScriptFiles(path.join(repositoryRoot, sourceRoot)),
			),
		)
	).flat();
	return Promise.all(
		sourceFiles.map(
			async (absoluteFilePath): Promise<ReliabilityFaultAuditSource> => ({
				content: await readFile(absoluteFilePath, 'utf8'),
				filePath: normalizeFilePath(path.relative(repositoryRoot, absoluteFilePath)),
			}),
		),
	);
}

async function runAuditCli(): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
	const sources = await readReliabilityFaultAuditSources(repositoryRoot);
	const findings = auditReliabilityFaultBoundaries(sources);
	if (findings.length === 0) {
		process.stdout.write('Reliability fault boundary audit passed.\n');
		return;
	}
	process.stderr.write(
		`${findings
			.map((finding) => `${finding.filePath}:${finding.line} ${finding.reason}`)
			.join('\n')}\n`,
	);
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await runAuditCli();
}
