import fs from 'node:fs';
import path from 'node:path';

interface PackageManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

const workspacePackageDirectory = path.resolve('packages');
const lockfilePath = path.resolve('pnpm-lock.yaml');

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePackageManifest(packageFile: string): PackageManifest {
	const parsedManifest: unknown = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
	if (!isRecord(parsedManifest)) {
		throw new Error(`${packageFile} must contain a JSON object.`);
	}
	return parsedManifest;
}

function dependencySections(
	manifest: PackageManifest,
): readonly Readonly<Record<string, string>>[] {
	return [
		manifest.dependencies ?? {},
		manifest.devDependencies ?? {},
		manifest.optionalDependencies ?? {},
		manifest.peerDependencies ?? {},
	];
}

function listWorkspacePackageFiles(): readonly string[] {
	return fs
		.readdirSync(workspacePackageDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(workspacePackageDirectory, entry.name, 'package.json'))
		.filter((packageFile) => fs.existsSync(packageFile));
}

function hasDirectDependency(manifest: PackageManifest, dependencyName: string): boolean {
	return dependencySections(manifest).some((section) => Object.hasOwn(section, dependencyName));
}

function collectViolations(): readonly string[] {
	const violations: string[] = [];
	const lockfile = fs.readFileSync(lockfilePath, 'utf8');
	if (/(^|\n)\s{2}zod@3\./u.test(lockfile)) {
		violations.push('pnpm-lock.yaml must not resolve zod@3.x; use direct zod ^4 dependencies.');
	}

	for (const packageFile of listWorkspacePackageFiles()) {
		const manifest = parsePackageManifest(packageFile);
		if (hasDirectDependency(manifest, 'zod-to-json-schema')) {
			violations.push(`${packageFile} must use z.toJSONSchema() instead of zod-to-json-schema.`);
		}
	}
	return violations;
}

const violations = collectViolations();
if (violations.length > 0) {
	for (const violation of violations) {
		process.stderr.write(`${violation}\n`);
	}
	process.exitCode = 1;
}
