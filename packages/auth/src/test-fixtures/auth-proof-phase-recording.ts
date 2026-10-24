import { appendFile } from 'node:fs/promises';
import path from 'node:path';

import { requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';

type AuthProofPhase =
	| {
			readonly kind: 'request-start';
			readonly requestId: string;
			readonly surface: 'jwks' | 'management';
			readonly targetOrigin: string;
	  }
	| { readonly kind: 'request-end'; readonly requestId: string; readonly status: number }
	| {
			readonly kind: 'cli-exit';
			readonly code: number | string | null;
			readonly signal: string | null;
			readonly killed: boolean;
			readonly authorizationUrlPrinted: boolean;
			readonly targetOrigin: string;
	  };

/** Closed diagnostic fields deliberately omit request headers, query values, stdout and credentials. */
export async function recordAuthProofPhase(event: AuthProofPhase): Promise<void> {
	const manifest = process.env.AUTH_PROOF_MANIFEST_FILE;
	if (manifest === undefined) return;
	const directory = path.dirname(await requirePrivateRuntimePath(manifest, true));
	await appendFile(
		path.join(directory, 'auth-proof-phases.jsonl'),
		`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
		{ mode: 0o600 },
	);
}
