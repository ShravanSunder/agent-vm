import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceTwo,
	workspaceAudience,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';
import { runCachedNativeOwnerCommand } from '#auth/test-fixtures/native-cli-proof';
import { agentCredentialSchema, workspaceToken } from '#auth/test-fixtures/workspace-agent-proof';

it('agent: delivered owner CLI registers, links, removes one workspace and retires without printing a credential', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await harness.ownerToken();
		const directory = path.dirname(harness.target.tokenCachePath);
		const outputFile = path.join(directory, 'workspace-agent-credential.json');
		const targetFile = path.join(directory, 'owner-cli-target.json');
		const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const registration = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'add-agent',
				'--persona',
				'operator',
				'--request-id',
				registrationRequestId,
				'--output',
				outputFile,
			],
		});
		expect(registration).toEqual({
			code: 0,
			stdout: 'Agent credential saved to the private output file.\n',
			stderr: '',
		});
		expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
		const credential = agentCredentialSchema
			.extend({
				kind: z.literal('registered'),
				workspaceId: z.literal(workspaceOne),
				resource: z.literal(workspaceAudience(workspaceOne)),
			})
			.strict()
			.parse(JSON.parse(await readFile(outputFile, 'utf8')));
		expect(credential.clientId).toBe(registeredClientId);
		const secretBefore = await harness.database
			.prepare('SELECT clientSecret FROM oauthClient WHERE clientId = ?')
			.bind(credential.clientId)
			.first();
		await writeFile(targetFile, JSON.stringify({ ...harness.target, workspaceId: workspaceTwo }), {
			mode: 0o600,
		});
		const link = await runCachedNativeOwnerCommand({
			target: { ...harness.target, workspaceId: workspaceTwo },
			repositoryRoot,
			args: [
				'add-agent',
				'--persona',
				'operator',
				'--request-id',
				crypto.randomUUID(),
				'--client-id',
				credential.clientId,
			],
		});
		expect(link).toEqual({ code: 0, stdout: `linked: ${credential.clientId}\n`, stderr: '' });
		expect(
			await harness.database
				.prepare('SELECT clientSecret FROM oauthClient WHERE clientId = ?')
				.bind(credential.clientId)
				.first(),
		).toEqual(secretBefore);
		expect(await workspaceToken({ harness, credential, workspaceId: workspaceTwo })).toBeTypeOf(
			'string',
		);
		await writeFile(targetFile, JSON.stringify(harness.target), { mode: 0o600 });
		const removed = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'remove-agent',
				'--client-id',
				credential.clientId,
				'--request-id',
				crypto.randomUUID(),
			],
		});
		expect(removed).toEqual({ code: 0, stdout: `removed: ${credential.clientId}\n`, stderr: '' });
		expect(
			(
				await harness.database
					.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
					.bind(credential.clientId)
					.all()
			).results,
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const retired = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'retire-agent',
				'--client-id',
				credential.clientId,
				'--request-id',
				crypto.randomUUID(),
			],
		});
		expect(retired).toEqual({ code: 0, stdout: `removed: ${credential.clientId}\n`, stderr: '' });
		expect(
			await harness.database
				.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM oauthClient WHERE clientId = ?')
				.bind(credential.clientId)
				.first(),
		).toEqual({ disabled: 1 });
		expect(
			(
				await harness.database
					.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
					.bind(credential.clientId)
					.all()
			).results,
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		for (const command of [registration, link, removed, retired]) {
			expect(command.stdout + command.stderr).not.toContain(credential.clientSecret);
		}
	} finally {
		await harness.close();
	}
}, 120_000);
