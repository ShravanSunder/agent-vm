import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const repositoryRoot = process.cwd();
const cliPath = path.join(repositoryRoot, 'packages/agent-vm/dist/cli/agent-vm-entrypoint.js');
const examplesRoot = path.join(repositoryRoot, 'docs/reference/configuration/examples');
const createdRoots: string[] = [];
const validationReportSchema = z.object({
	ok: z.boolean(),
	checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
});

interface ConfigEdit {
	readonly path: readonly (string | number)[];
	readonly value: unknown;
}
interface CliResult {
	readonly exitCode: number;
	readonly output: string;
	readonly stdout: string;
}
function editConfig(text: string, edits: readonly ConfigEdit[]): string {
	return edits.reduce(
		(current, edit) =>
			applyEdits(
				current,
				modify(current, [...edit.path], edit.value, {
					formattingOptions: { insertSpaces: false, tabSize: 1 },
				}),
			),
		text,
	);
}
async function runCli(root: string, arguments_: readonly string[]): Promise<CliResult> {
	const result = await execa('node', [cliPath, ...arguments_], {
		cwd: root,
		reject: false,
		timeout: 30_000,
	});
	return {
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout,
		output: `${result.stdout}\n${result.stderr}`,
	};
}

afterEach(async () => {
	await Promise.all(
		createdRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('profile-owned OAuth config through the built CLI', () => {
	it('validates migrated examples and rejects old, unknown, and missing authority', async () => {
		// Arrange: run the actual scaffold command in an isolated deployment root.
		const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-oauth-profile-cli-'));
		createdRoots.push(root);
		const initialized = await runCli(root, [
			'init',
			'sun',
			'--type',
			'hermes',
			'--secrets',
			'environment',
			'--paths',
			'local',
			'--arch',
			process.arch === 'arm64' ? 'aarch64' : 'x86_64',
		]);
		expect(initialized.exitCode, initialized.output).toBe(0);
		const generatedSchema = await readFile(
			path.join(root, 'config/schemas/tool-portal.schema.json'),
			'utf8',
		);
		expect(generatedSchema).toContain('"oauthApplications"');
		expect(generatedSchema).not.toContain('"googlePolicyDefaults"');
		const systemPath = path.join(root, 'config/system.jsonc');
		const systemText = await readFile(systemPath, 'utf8');
		await writeFile(
			systemPath,
			editConfig(systemText, [
				{
					path: ['zones', 0, 'approvalAccess'],
					value: {
						audience: 'agent-vm-controller-approval',
						approvers: [{ kind: 'managed_gateway', approverId: 'profile-config-test' }],
					},
				},
				{
					path: ['zones', 0, 'toolPortal', 'surfaceEligibilityByProfile'],
					value: {
						'google-read-defaults': {
							google: ['protected_uds'],
							oauth_authorization: ['protected_uds'],
						},
						'google-ask-defaults': {
							google: ['protected_uds'],
							oauth_authorization: ['protected_uds'],
						},
					},
				},
			]),
		);
		const configRoot = path.join(root, 'config/gateways/sun');
		const oauthPath = path.join(configRoot, 'oauth.config.jsonc');
		const portalPath = path.join(configRoot, 'tool-portal.config.jsonc');
		const oauthText = editConfig(
			await readFile(path.join(examplesRoot, 'oauth-v2.config.jsonc'), 'utf8'),
			[
				{ path: ['zoneId'], value: 'sun' },
				{ path: ['owners', 'example-owner', 'allowedAgentIds'], value: ['main'] },
				{ path: ['policyEditors', 'example-editor', 'editableAgentIds'], value: ['main'] },
			],
		);
		const portalText = editConfig(
			await readFile(path.join(examplesRoot, 'tool-portal-google-policy.config.jsonc'), 'utf8'),
			[{ path: ['agents'], value: { main: { profile: 'google-ask-defaults' } } }],
		);
		await writeFile(oauthPath, oauthText);
		await writeFile(portalPath, portalText);
		const validateArguments = ['validate', '--config', 'config/system.jsonc'];

		// Act / Assert: explicit recommendation and named collection profiles both validate.
		const valid = await runCli(root, validateArguments);
		expect(valid.exitCode, valid.output).toBe(0);
		expect(validationReportSchema.parse(JSON.parse(valid.stdout)).ok, valid.output).toBe(true);
		expect(await readFile(portalPath, 'utf8')).toContain('consentRecommendation');
		expect(await readFile(oauthPath, 'utf8')).not.toContain('"agents"');

		await writeFile(
			oauthPath,
			editConfig(oauthText, [{ path: ['agents'], value: { sun: { applications: {} } } }]),
		);
		const legacy = await runCli(root, validateArguments);
		expect(validationReportSchema.parse(JSON.parse(legacy.stdout)).ok, legacy.output).toBe(false);
		expect(legacy.output).toContain('agents');
		await writeFile(oauthPath, oauthText);

		await writeFile(
			portalPath,
			editConfig(portalText, [
				{
					path: ['profiles', 'google-read-defaults', 'oauthApplications', 'unknown-app'],
					value: { ceiling: { kind: 'explicit', groupIds: [] } },
				},
			]),
		);
		const unknown = await runCli(root, validateArguments);
		expect(validationReportSchema.parse(JSON.parse(unknown.stdout)).ok, unknown.output).toBe(false);
		expect(unknown.output).toContain('unknown-app');

		await writeFile(
			portalPath,
			editConfig(portalText, [
				{
					path: [
						'profiles',
						'google-ask-defaults',
						'oauthApplications',
						'gmail-app',
						'consentRecommendation',
						'groupIds',
					],
					value: ['gmail.read', 'gmail.read'],
				},
			]),
		);
		const duplicate = await runCli(root, validateArguments);
		expect(validationReportSchema.parse(JSON.parse(duplicate.stdout)).ok, duplicate.output).toBe(
			false,
		);
		expect(duplicate.output).toContain('groupIds');

		// Declaration-only profiles still require the registration file.
		await writeFile(
			portalPath,
			editConfig(portalText, [
				{ path: ['profiles', 'google-read-defaults', 'namespaces'], value: {} },
				{ path: ['profiles', 'google-ask-defaults', 'namespaces'], value: {} },
			]),
		);
		await unlink(oauthPath);
		const missing = await runCli(root, validateArguments);
		expect(validationReportSchema.parse(JSON.parse(missing.stdout)).ok, missing.output).toBe(false);
		expect(validationReportSchema.parse(JSON.parse(missing.stdout)).checks).toContainEqual({
			name: 'oauth-config-sun',
			ok: false,
		});
		expect(missing.output).toContain('oauth.config.jsonc');
	});
});
