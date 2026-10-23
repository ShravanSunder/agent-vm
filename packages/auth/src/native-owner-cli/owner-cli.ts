/** Owner management CLI: browser code+S256 login, live owner checks on every server command, no refresh. */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { readAuthTarget, requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';
import { ownerManagementToken } from '#auth/native-owner-cli/owner-cli-login';

export async function runOwnerCli(args: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			help: { type: 'boolean' },
			target: { type: 'string' },
			'force-auth': { type: 'boolean' },
			'no-browser': { type: 'boolean' },
			'request-id': { type: 'string' },
			'client-id': { type: 'string' },
			output: { type: 'string' },
		},
	});

	if (values.help === true) {
		process.stdout
			.write(`Usage: mise exec -- node scripts/verify-auth/owner-cli.ts --target FILE COMMAND [OPTIONS]
Commands: login | add-agent --request-id UUID --output FILE | remove-agent --client-id ID --request-id UUID | agent-status --client-id ID
Target JSON: issuer, managementAudience, gatewayUrl, organizationId, ownerCliClientId, ownerCliRedirectUri, tokenCachePath.
Target and token cache are owned mode-0600 files outside Git checkouts. Credential output is created mode0600 and must not exist.
--force-auth starts a new browser authorization. Expiry requires another authorization; no refresh token is requested or accepted.
--no-browser prints the authorization URL for a browser on another machine; it never prints a credential.
This switch makes no hardware-presence or per-command human-intent claim. Every management request checks the live Person/session.\n`);
	} else {
		try {
			const target = await readAuthTarget(z.string().min(1).parse(values.target));
			const command = z
				.enum(['login', 'add-agent', 'remove-agent', 'agent-status'])
				.parse(positionals[0]);
			if (positionals.length !== 1) throw new Error('Expected exactly one owner command');
			const requestId =
				command === 'add-agent' || command === 'remove-agent'
					? z.uuid().parse(values['request-id'])
					: undefined;
			const clientId =
				command === 'remove-agent' || command === 'agent-status'
					? z.string().min(1).parse(values['client-id'])
					: undefined;
			const output =
				command === 'add-agent'
					? await requirePrivateRuntimePath(z.string().min(1).parse(values.output), false)
					: undefined;
			const token = await ownerManagementToken({
				target,
				forceAuth: values['force-auth'] === true,
				...(values['no-browser'] === true
					? {
							browser: async (url: string): Promise<void> => {
								process.stdout.write(`AUTHORIZATION_URL=${url}\n`);
							},
						}
					: {}),
			});
			if (command === 'login')
				process.stdout.write(
					'Owner management credential ready. Each command still checks the live session.\n',
				);
			else {
				const endpoint = new URL(
					`/management/organizations/${target.organizationId}/agents${clientId === undefined ? '' : `/${encodeURIComponent(clientId)}`}`,
					target.gatewayUrl,
				);
				const method =
					command === 'add-agent' ? 'POST' : command === 'remove-agent' ? 'DELETE' : 'GET';
				const body = method === 'GET' ? undefined : JSON.stringify({ requestId });
				const response = await fetch(endpoint, {
					method,
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					...(body === undefined ? {} : { body }),
				});
				if (!response.ok)
					throw new Error(`Owner management refused (${response.status}); no credential released`);
				const result: unknown = await response.json();
				if (output !== undefined) {
					const registration = z
						.strictObject({
							kind: z.literal('registered'),
							clientId: z.string(),
							clientSecret: z.string(),
						})
						.parse(result);
					await writeFile(output, JSON.stringify(registration), { mode: 0o600, flag: 'wx' });
					process.stdout.write('Agent credential saved to the private output file.\n');
				} else {
					const status = z
						.strictObject({
							kind: z.enum(['listed', 'unlisted', 'removed', 'removal-pending']),
							clientId: z.string(),
						})
						.parse(result);
					process.stdout.write(`${status.kind}: ${status.clientId}\n`);
				}
			}
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : 'Owner command failed'}\n`);
			return 1;
		}
	}
	return 0;
}
