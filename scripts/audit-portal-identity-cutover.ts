import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = [
	'packages/tool-host-core/src/caller-admission',
	'packages/tool-host-core/src/workspace-authority',
	'packages/tool-host-core/src/agent-management',
	'packages/tool-host-cloudflare/src/durable-workspace-authority',
];
async function sourceFiles(directory: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		throw error;
	}
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const filename = path.join(directory, entry.name);
				if (entry.isDirectory()) return entry.name === 'test-fixtures' ? [] : sourceFiles(filename);
				return filename.endsWith('.ts') && !filename.endsWith('.test.ts') ? [filename] : [];
			}),
		)
	).flat();
}
const filenames = [
	...(await Promise.all(roots.map(sourceFiles))).flat(),
	'packages/tool-host-cloudflare/src/index.ts',
];
const forbidden =
	/readMembership|setMembership|beginAgentRemoval|completeAgentRemoval|member:|member-removal:|agentAdmissionSchema|createWorkspaceAgentManagement|\/management\/|SIGN_IN\??:/u;
const failures = (
	await Promise.all(
		filenames.map(async (filename) =>
			forbidden.test(await readFile(filename, 'utf8')) ? filename : null,
		),
	)
).filter((filename) => filename !== null);
if (failures.length > 0)
	throw new Error(
		`Portal identity cutover retains a membership or management contract: ${failures.join(', ')}`,
	);
process.stdout.write(
	`Portal identity cutover: ${String(filenames.length)} runtime files checked; no membership store or management route.\n`,
);
