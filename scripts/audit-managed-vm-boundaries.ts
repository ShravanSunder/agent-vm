import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

export interface ManagedVmBoundaryAuditSource {
	readonly content: string;
	readonly filePath: string;
}

export interface ManagedVmBoundaryAuditFinding {
	readonly filePath: string;
	readonly line: number;
	readonly reason: string;
}

const ADAPTER_PACKAGE = '@agent-vm/gondolin-vm-adapter';
const GONDOLIN_SDK_PACKAGE = '@earendil-works/gondolin';
const GONDOLIN_SDK_VERSION = '0.12.0';
const OLD_PACKAGE_NAMES = ['@agent-vm/gondolin-adapter', '@agent-vm/gateway-interface'] as const;
const ALLOWED_ADAPTER_IMPORTERS = new Set([
	'packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts',
	'packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts',
]);
const ROOT_METADATA_PATHS = [
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'tsconfig.base.json',
	'tsconfig.json',
] as const;

type JsonObject = Readonly<Record<string, unknown>>;

function normalizeFilePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function parseJsonObject(content: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(content);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as JsonObject)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseJsonOrJsoncObject(source: ManagedVmBoundaryAuditSource): JsonObject | undefined {
	const parsedJson = parseJsonObject(source.content);
	if (parsedJson !== undefined) {
		return parsedJson;
	}
	const parsedConfig = ts.parseConfigFileTextToJson(source.filePath, source.content);
	return typeof parsedConfig.config === 'object' &&
		parsedConfig.config !== null &&
		!Array.isArray(parsedConfig.config)
		? (parsedConfig.config as JsonObject)
		: undefined;
}

function objectProperty(value: unknown, propertyName: string): JsonObject | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const property = (value as JsonObject)[propertyName];
	return typeof property === 'object' && property !== null && !Array.isArray(property)
		? (property as JsonObject)
		: undefined;
}

function isProductionTypeScriptFile(filePath: string): boolean {
	return (
		filePath.startsWith('packages/') &&
		filePath.includes('/src/') &&
		/\.(?:cts|mts|ts|tsx)$/u.test(filePath) &&
		!/[.](?:spec|test)[.](?:cts|mts|ts|tsx)$/u.test(filePath) &&
		!filePath.includes('/integration-tests/') &&
		!filePath.includes('/fixtures/')
	);
}

function moduleSpecifierTargetsAdapter(options: {
	readonly adapterAliases: ReadonlySet<string>;
	readonly importerPath: string;
	readonly moduleSpecifier: string;
}): boolean {
	if (resolvesPackage(options.moduleSpecifier, ADAPTER_PACKAGE)) {
		return true;
	}
	if (
		[...options.adapterAliases].some(
			(alias) =>
				options.moduleSpecifier === alias || options.moduleSpecifier.startsWith(`${alias}/`),
		)
	) {
		return true;
	}
	if (!options.moduleSpecifier.startsWith('.')) {
		return false;
	}
	const resolvedPath = path.posix.normalize(
		path.posix.join(path.posix.dirname(options.importerPath), options.moduleSpecifier),
	);
	return (
		resolvedPath === 'packages/gondolin-vm-adapter/src' ||
		resolvedPath.startsWith('packages/gondolin-vm-adapter/src/')
	);
}

function moduleSpecifiers(source: ManagedVmBoundaryAuditSource): readonly {
	readonly line: number;
	readonly value: string;
}[] {
	const sourceFile = ts.createSourceFile(
		source.filePath,
		source.content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const results: { line: number; value: string }[] = [];
	const addStringLiteral = (literal: ts.StringLiteralLike): void => {
		results.push({
			line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
			value: literal.text,
		});
	};
	const visit = (node: ts.Node): void => {
		const firstArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			addStringLiteral(node.moduleSpecifier);
		}
		if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			firstArgument !== undefined &&
			ts.isStringLiteralLike(firstArgument) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			addStringLiteral(firstArgument);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return results;
}

function pathAliasesToAdapter(
	sources: readonly ManagedVmBoundaryAuditSource[],
): ReadonlySet<string> {
	const aliases = new Set<string>();
	for (const source of sources) {
		if (!source.filePath.endsWith('.json') && !source.filePath.endsWith('.jsonc')) {
			continue;
		}
		const parsed = parseJsonOrJsoncObject(source);
		const paths = objectProperty(objectProperty(parsed, 'compilerOptions'), 'paths');
		if (paths === undefined) {
			continue;
		}
		for (const [alias, targets] of Object.entries(paths)) {
			if (
				Array.isArray(targets) &&
				targets.some((target) => {
					if (typeof target !== 'string') {
						return false;
					}
					const resolvedTarget = path.posix.normalize(
						path.posix.join(path.posix.dirname(source.filePath), normalizeFilePath(target)),
					);
					return (
						resolvedTarget === 'packages/gondolin-vm-adapter/src' ||
						resolvedTarget.startsWith('packages/gondolin-vm-adapter/src/')
					);
				})
			) {
				aliases.add(alias.replace(/\/\*$/u, ''));
			}
		}
	}
	return aliases;
}

function resolvesPackage(moduleSpecifier: string, packageName: string): boolean {
	return moduleSpecifier === packageName || moduleSpecifier.startsWith(`${packageName}/`);
}

function dependencyEntries(manifest: JsonObject): readonly [string, string, string][] {
	const entries: [string, string, string][] = [];
	for (const field of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies',
	] as const) {
		const dependencies = objectProperty(manifest, field);
		for (const [dependencyName, version] of Object.entries(dependencies ?? {})) {
			if (typeof version === 'string') {
				entries.push([field, dependencyName, version]);
			}
		}
	}
	return entries;
}

function insertFinding(
	findings: ManagedVmBoundaryAuditFinding[],
	source: ManagedVmBoundaryAuditSource,
	reason: string,
	line = 1,
): void {
	if (
		!findings.some(
			(finding) =>
				finding.filePath === source.filePath && finding.line === line && finding.reason === reason,
		)
	) {
		findings.push({ filePath: source.filePath, line, reason });
	}
}

function auditManifest(
	source: ManagedVmBoundaryAuditSource,
	findings: ManagedVmBoundaryAuditFinding[],
): void {
	if (!source.filePath.startsWith('packages/') || !source.filePath.endsWith('/package.json')) {
		return;
	}
	const manifest = parseJsonObject(source.content);
	const packageName = manifest?.name;
	if (typeof packageName !== 'string') {
		insertFinding(findings, source, 'workspace package manifest has no package name');
		return;
	}
	if (manifest === undefined) {
		return;
	}
	const dependencies = dependencyEntries(manifest);
	const allEdges = new Map(
		dependencies.map(([, dependencyName, version]) => [dependencyName, version]),
	);
	const forbiddenTargets = new Set<string>();
	if (packageName === '@agent-vm/managed-vm') {
		forbiddenTargets.add(GONDOLIN_SDK_PACKAGE);
		for (const dependencyName of allEdges.keys()) {
			if (dependencyName.startsWith('@agent-vm/')) {
				forbiddenTargets.add(dependencyName);
			}
		}
	}
	if (packageName === '@agent-vm/gateway-lifecycle') {
		forbiddenTargets.add(ADAPTER_PACKAGE);
		forbiddenTargets.add('@agent-vm/agent-vm');
		forbiddenTargets.add(GONDOLIN_SDK_PACKAGE);
	}
	if (
		packageName === '@agent-vm/openclaw-gateway' ||
		packageName === '@agent-vm/worker-gateway' ||
		packageName === '@agent-vm/hermes-gateway'
	) {
		forbiddenTargets.add(ADAPTER_PACKAGE);
	}
	if (packageName === ADAPTER_PACKAGE) {
		forbiddenTargets.add('@agent-vm/agent-vm');
		forbiddenTargets.add('@agent-vm/gateway-lifecycle');
		forbiddenTargets.add('@agent-vm/openclaw-gateway');
		forbiddenTargets.add('@agent-vm/worker-gateway');
		forbiddenTargets.add('@agent-vm/hermes-gateway');
	}
	for (const dependencyName of allEdges.keys()) {
		if (forbiddenTargets.has(dependencyName)) {
			insertFinding(
				findings,
				source,
				`forbidden package edge '${packageName}' -> '${dependencyName}'`,
			);
		}
	}
	if (packageName === '@agent-vm/agent-vm') {
		const adapterEntries = dependencies.filter(
			([, dependencyName]) => dependencyName === ADAPTER_PACKAGE,
		);
		if (
			adapterEntries.length !== 1 ||
			adapterEntries[0]?.[0] !== 'dependencies' ||
			adapterEntries[0]?.[2] !== 'workspace:*'
		) {
			insertFinding(
				findings,
				source,
				`@agent-vm/agent-vm must declare '${ADAPTER_PACKAGE}' as an exact workspace dependency`,
			);
		}
	}
	if (packageName === ADAPTER_PACKAGE) {
		const sdkEntries = dependencies.filter(
			([, dependencyName]) => dependencyName === GONDOLIN_SDK_PACKAGE,
		);
		if (
			sdkEntries.length !== 1 ||
			sdkEntries[0]?.[0] !== 'dependencies' ||
			sdkEntries[0]?.[2] !== GONDOLIN_SDK_VERSION
		) {
			insertFinding(
				findings,
				source,
				`Gondolin SDK dependency must be exact stock version '${GONDOLIN_SDK_VERSION}'`,
			);
		}
	}
}

function auditGondolinProvenance(
	source: ManagedVmBoundaryAuditSource,
	findings: ManagedVmBoundaryAuditFinding[],
): void {
	if (!source.content.includes(GONDOLIN_SDK_PACKAGE) && !source.filePath.includes('gondolin')) {
		return;
	}
	if (/patchedDependencies|\boverrides\b|@patch:|patch_hash/iu.test(source.content)) {
		insertFinding(findings, source, 'Gondolin SDK patch or override configuration is forbidden');
	}
	const parsed = parseJsonObject(source.content);
	const jsonSdkVersions =
		parsed === undefined
			? []
			: dependencyEntries(parsed)
					.filter(([, dependencyName]) => dependencyName === GONDOLIN_SDK_PACKAGE)
					.map(([, , version]) => version);
	const pnpmOverrides = objectProperty(objectProperty(parsed, 'pnpm'), 'overrides');
	const overriddenSdkVersion = pnpmOverrides?.[GONDOLIN_SDK_PACKAGE];
	const yamlHasLocalSdkResolution =
		parsed === undefined &&
		source.content.split('\n').some((line, lineIndex, lines) => {
			if (!line.includes(GONDOLIN_SDK_PACKAGE)) {
				return false;
			}
			return lines
				.slice(lineIndex, lineIndex + 4)
				.join('\n')
				.match(/(?:file|link|local|workspace):/u);
		});
	if (
		jsonSdkVersions.some((version) => /^(?:file|link|local|workspace):/u.test(version)) ||
		(typeof overriddenSdkVersion === 'string' &&
			/^(?:file|link|local|workspace):/u.test(overriddenSdkVersion)) ||
		yamlHasLocalSdkResolution
	) {
		insertFinding(findings, source, 'Gondolin SDK local replacement is forbidden');
	}
}

export function auditManagedVmBoundaries(
	sources: readonly ManagedVmBoundaryAuditSource[],
): readonly ManagedVmBoundaryAuditFinding[] {
	const normalizedSources = sources.map((source) => ({
		...source,
		filePath: normalizeFilePath(source.filePath),
	}));
	const findings: ManagedVmBoundaryAuditFinding[] = [];
	const adapterAliases = pathAliasesToAdapter(normalizedSources);
	const observedAdapterImporters = new Set<string>();
	for (const source of normalizedSources) {
		auditManifest(source, findings);
		auditGondolinProvenance(source, findings);
		const activeSurface =
			isProductionTypeScriptFile(source.filePath) ||
			source.filePath.endsWith('/package.json') ||
			ROOT_METADATA_PATHS.some((metadataPath) => metadataPath === source.filePath);
		if (activeSurface) {
			for (const oldPackageName of OLD_PACKAGE_NAMES) {
				if (source.content.includes(oldPackageName)) {
					insertFinding(
						findings,
						source,
						`active old package name '${oldPackageName}' is forbidden`,
					);
				}
			}
		}
		if (!isProductionTypeScriptFile(source.filePath)) {
			continue;
		}
		for (const moduleSpecifier of moduleSpecifiers(source)) {
			const importsAdapter = moduleSpecifierTargetsAdapter({
				adapterAliases,
				importerPath: source.filePath,
				moduleSpecifier: moduleSpecifier.value,
			});
			if (importsAdapter && !source.filePath.startsWith('packages/gondolin-vm-adapter/src/')) {
				observedAdapterImporters.add(source.filePath);
				if (!ALLOWED_ADAPTER_IMPORTERS.has(source.filePath)) {
					insertFinding(
						findings,
						source,
						'production adapter import is forbidden outside the exact two-module allowlist',
						moduleSpecifier.line,
					);
				}
			}
			if (
				resolvesPackage(moduleSpecifier.value, GONDOLIN_SDK_PACKAGE) &&
				!source.filePath.startsWith('packages/gondolin-vm-adapter/src/')
			) {
				insertFinding(
					findings,
					source,
					'only @agent-vm/gondolin-vm-adapter may import the Gondolin SDK',
					moduleSpecifier.line,
				);
			}
		}
	}
	for (const allowedImporter of ALLOWED_ADAPTER_IMPORTERS) {
		if (!observedAdapterImporters.has(allowedImporter)) {
			insertFinding(
				findings,
				{ content: '', filePath: allowedImporter },
				'exact allowlisted production adapter import is missing',
			);
		}
	}
	return findings.toSorted(
		(left, right) =>
			left.filePath.localeCompare(right.filePath) ||
			left.line - right.line ||
			left.reason.localeCompare(right.reason),
	);
}

async function listFilesRecursively(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry): Promise<readonly string[]> => {
				const entryPath = path.join(directoryPath, entry.name);
				if (entry.isDirectory()) {
					return await listFilesRecursively(entryPath);
				}
				return entry.isFile() ? [entryPath] : [];
			}),
		)
	).flat();
}

export async function readManagedVmBoundaryAuditSources(
	repositoryRoot: string,
): Promise<readonly ManagedVmBoundaryAuditSource[]> {
	const packageFiles = await listFilesRecursively(path.join(repositoryRoot, 'packages'));
	const selectedPackageFiles = packageFiles.filter((absoluteFilePath) => {
		const relativePath = normalizeFilePath(path.relative(repositoryRoot, absoluteFilePath));
		return (
			relativePath.endsWith('/package.json') ||
			/(?:^|\/)tsconfig[^/]*[.]jsonc?$/u.test(relativePath) ||
			isProductionTypeScriptFile(relativePath)
		);
	});
	const rootFiles = await Promise.all(
		ROOT_METADATA_PATHS.map(async (relativePath) => {
			try {
				await readFile(path.join(repositoryRoot, relativePath), 'utf8');
				return path.join(repositoryRoot, relativePath);
			} catch {
				return undefined;
			}
		}),
	);
	return await Promise.all(
		[
			...selectedPackageFiles,
			...rootFiles.filter((value): value is string => value !== undefined),
		].map(
			async (absoluteFilePath): Promise<ManagedVmBoundaryAuditSource> => ({
				content: await readFile(absoluteFilePath, 'utf8'),
				filePath: normalizeFilePath(path.relative(repositoryRoot, absoluteFilePath)),
			}),
		),
	);
}

async function runAudit(): Promise<void> {
	const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const findings = auditManagedVmBoundaries(
		await readManagedVmBoundaryAuditSources(repositoryRoot),
	);
	if (findings.length === 0) {
		process.stdout.write('managed VM package and production import boundary audit passed\n');
		return;
	}
	process.stderr.write(
		`${findings.map((finding) => `${finding.filePath}:${finding.line} ${finding.reason}`).join('\n')}\n`,
	);
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await runAudit();
}
