import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const forbiddenActivePaths = [
	'docker/base-images/openclaw-gateway',
	'docs/architecture/openclaw-gateway.md',
	'docs/getting-started/openclaw-guide.md',
	'packages/agent-vm/src/gateway-api-client',
	'packages/openclaw-agent-vm-plugin',
	'packages/openclaw-gateway',
	'packages/openclaw-mcp-portal-plugin',
] as const;

const currentDocumentationRoots = [
	'AGENTS.md',
	'CLAUDE.md',
	'README.md',
	'docs/README.md',
	'docs/architecture',
	'docs/getting-started',
	'docs/reference',
	'docs/subsystems',
] as const;

const operationalFiles = [
	'.oxlintrc.json',
	'.github/actions/restore-e2e-image-cache/action.yml',
	'.github/workflows/ci.yml',
	'.github/workflows/publish.yml',
	'package.json',
	'packages/agent-vm/managed-images.json',
	'packages/agent-vm/package.json',
	'packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.llm.e2e.test.ts',
	'pnpm-lock.yaml',
	'scripts/check-package-version-sync.sh',
	'scripts/audit-portal-architecture.ts',
	'scripts/audit-portal-architecture.unit.test.ts',
	'scripts/prepare-e2e-image-cache.ts',
	'scripts/run-e2e-proof-lanes.ts',
	'scripts/sync-local-tarballs-to-deployment.ts',
	'scripts/verify-portal-package-exports.ts',
	'tsconfig.base.json',
	'vitest.config.ts',
] as const;

// These tests intentionally exercise rejection, absence, predecessor guidance,
// or removal enforcement. Every other active test must use Hermes or
// framework-neutral vocabulary.
const classifiedRemovalTestFiles = new Set([
	'packages/agent-vm/src/build/managed-image-release.unit.test.ts',
	'packages/agent-vm/src/cli/agent-vm-command-parser.unit.test.ts',
	'packages/agent-vm/src/cli/init-command.integration.test.ts',
	'packages/agent-vm/src/cli/manual-templates.unit.test.ts',
	'packages/agent-vm/src/cli/publish-workflow.unit.test.ts',
	'packages/agent-vm/src/cli/ssh-commands.unit.test.ts',
	'packages/agent-vm/src/controller/controller-runtime.unit.test.ts',
	'packages/agent-vm/src/controller/reliability/testing/reliability-test-fault-contracts.unit.test.ts',
	'packages/agent-vm/src/controller/zone-runtimes/managed-gateway-zone-runtime.unit.test.ts',
	'packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts',
	'packages/agent-vm/src/integration-tests/hermes-e2e-harness.integration.test.ts',
	'packages/agent-vm/src/integration-tests/production-config.integration.test.ts',
	'packages/gateway-lifecycle/src/managed-gateway-boot-contract.unit.test.ts',
	'packages/gateway-runtime/src/managed-tool-portal-real-backends.integration.test.ts',
	'packages/gondolin-vm-adapter/src/managed-gateway-rootfs-init.unit.test.ts',
	'packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.unit.test.ts',
	'packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-module-boundary.unit.test.ts',
	'scripts/audit-managed-vm-boundaries.unit.test.ts',
	'scripts/audit-openclaw-removal.unit.test.ts',
	'scripts/audit-test-taxonomy.unit.test.ts',
	'scripts/ci-workflow.unit.test.ts',
	'scripts/inspect-managed-vm-package-cut.unit.test.ts',
]);
const fixtureAuditSelfTestPath = 'scripts/audit-openclaw-removal.unit.test.ts';

const removedSshSecretModePattern = /--all-secrets|requestAllSecrets|secretEnvEnabled/u;
const misleadingPositiveFixturePattern =
	/HERMES_GATEWAY_TOKEN|claw-tests|Hermes-compatible synthetic|Hermes SSRF compatibility|hermes-(?:all-secrets|gateway-token)\.environment\.sh/u;

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function pathHasActiveContent(filePath: string): Promise<boolean> {
	if (!(await pathExists(filePath))) return false;
	const pathStatus = await stat(filePath);
	return pathStatus.isDirectory() ? (await listFilesRecursively(filePath)).length > 0 : true;
}

async function listFilesRecursively(rootPath: string): Promise<readonly string[]> {
	if (!(await pathExists(rootPath))) return [];
	const entries = await readdir(rootPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(rootPath, entry.name);
			return entry.isDirectory() ? await listFilesRecursively(entryPath) : [entryPath];
		}),
	);
	return nestedFiles.flat();
}

async function collectTextResidue(
	repositoryRoot: string,
	filePaths: readonly string[],
): Promise<readonly string[]> {
	const violations: string[] = [];
	for (const filePath of filePaths) {
		if (!(await pathExists(filePath))) continue;
		const sourceText = await readFile(filePath, 'utf8');
		if (/openclaw/iu.test(sourceText)) {
			violations.push(
				`${path.relative(repositoryRoot, filePath)} contains active OpenClaw residue`,
			);
		}
	}
	return violations;
}

async function collectRemovedSshSecretModeResidue(
	repositoryRoot: string,
	filePaths: readonly string[],
): Promise<readonly string[]> {
	const violations = await Promise.all(
		filePaths.map(async (filePath): Promise<string | undefined> => {
			const sourceText = await readFile(filePath, 'utf8');
			return removedSshSecretModePattern.test(sourceText)
				? `${path.relative(repositoryRoot, filePath)} contains removed SSH secret-mode residue`
				: undefined;
		}),
	);
	return violations.filter((violation): violation is string => violation !== undefined);
}

async function collectMisleadingPositiveFixtureResidue(
	repositoryRoot: string,
	filePaths: readonly string[],
): Promise<readonly string[]> {
	const violations = await Promise.all(
		filePaths.map(async (filePath): Promise<string | undefined> => {
			const sourceText = await readFile(filePath, 'utf8');
			return misleadingPositiveFixturePattern.test(sourceText)
				? `${path.relative(repositoryRoot, filePath)} contains misleading framework fixture residue`
				: undefined;
		}),
	);
	return violations.filter((violation): violation is string => violation !== undefined);
}

export async function auditOpenClawRemoval(repositoryRoot: string): Promise<readonly string[]> {
	const forbiddenPathViolations = (
		await Promise.all(
			forbiddenActivePaths.map(async (relativePath) =>
				(await pathHasActiveContent(path.join(repositoryRoot, relativePath)))
					? `${relativePath} remains active`
					: undefined,
			),
		)
	).filter((violation): violation is string => violation !== undefined);

	const packageSourceFiles = (await listFilesRecursively(path.join(repositoryRoot, 'packages')))
		.filter((filePath) => filePath.includes(`${path.sep}src${path.sep}`))
		.filter((filePath) => filePath.endsWith('.ts'))
		.filter((filePath) => !/\.(?:test|spec)\.ts$/u.test(filePath))
		.filter(
			(filePath) =>
				filePath !==
				path.join(repositoryRoot, 'packages', 'agent-vm', 'src', 'cli', 'manual-templates.ts'),
		);
	const currentDocumentationFiles = (
		await Promise.all(
			currentDocumentationRoots.map(async (relativePath) => {
				const absolutePath = path.join(repositoryRoot, relativePath);
				if (!(await pathExists(absolutePath))) return [];
				const pathStatus = await stat(absolutePath);
				return pathStatus.isDirectory() ? await listFilesRecursively(absolutePath) : [absolutePath];
			}),
		)
	)
		.flat()
		.filter((filePath) => filePath.endsWith('.md'));
	const operationalAbsolutePaths = operationalFiles.map((relativePath) =>
		path.join(repositoryRoot, relativePath),
	);
	const operationalAbsolutePathSet = new Set(operationalAbsolutePaths);
	const activeTestFiles = [
		...new Set([
			...(await listFilesRecursively(path.join(repositoryRoot, 'packages'))),
			...(await listFilesRecursively(path.join(repositoryRoot, 'scripts'))),
		]),
	]
		.filter((filePath) => /\.(?:test|spec)\.ts$/u.test(filePath))
		.filter((filePath) => !operationalAbsolutePathSet.has(filePath))
		.filter(
			(filePath) =>
				!classifiedRemovalTestFiles.has(
					path.relative(repositoryRoot, filePath).replaceAll('\\', '/'),
				),
		);
	const allTestFiles = [
		...new Set([
			...(await listFilesRecursively(path.join(repositoryRoot, 'packages'))),
			...(await listFilesRecursively(path.join(repositoryRoot, 'scripts'))),
		]),
	]
		.filter((filePath) => /\.(?:test|spec)\.ts$/u.test(filePath))
		.filter(
			(filePath) =>
				path.relative(repositoryRoot, filePath).replaceAll('\\', '/') !== fixtureAuditSelfTestPath,
		);

	return [
		...forbiddenPathViolations,
		...(await collectTextResidue(repositoryRoot, packageSourceFiles)),
		...(await collectRemovedSshSecretModeResidue(repositoryRoot, packageSourceFiles)),
		...(await collectTextResidue(repositoryRoot, currentDocumentationFiles)),
		...(await collectTextResidue(repositoryRoot, operationalAbsolutePaths)),
		...(await collectTextResidue(repositoryRoot, activeTestFiles)),
		...(await collectMisleadingPositiveFixtureResidue(repositoryRoot, allTestFiles)),
	].toSorted();
}
