/** Owner management CLI: browser code+S256 login, live owner checks on every server command, no refresh. */
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { readAuthTarget } from '#auth/native-owner-cli/auth-target';
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
		},
	});

	if (values.help === true) {
		process.stdout
			.write(`Usage: mise exec -- node scripts/verify-auth/owner-cli.ts --target FILE COMMAND [OPTIONS]
Commands: login
Target JSON: issuer, managementAudience, gatewayUrl, organizationId, workspaceId, ownerCliClientId, ownerCliRedirectUri, tokenCachePath.
Target and token cache are owned mode-0600 files outside Git checkouts.
--force-auth starts a new browser authorization. Expiry requires another authorization; no refresh token is requested or accepted.
--no-browser prints the authorization URL for a browser on another machine; it never prints a credential.
This switch makes no hardware-presence or per-command human-intent claim. Fleet administration owns bot credential and workspace changes.\n`);
	} else {
		try {
			const target = await readAuthTarget(z.string().min(1).parse(values.target));
			z.literal('login').parse(positionals[0]);
			if (positionals.length !== 1) throw new Error('Expected exactly one owner command');
			await ownerManagementToken({
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
			process.stdout.write(
				'Owner sign-in credential ready. Administration checks the live session.\n',
			);
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : 'Owner command failed'}\n`);
			return 1;
		}
	}
	return 0;
}
