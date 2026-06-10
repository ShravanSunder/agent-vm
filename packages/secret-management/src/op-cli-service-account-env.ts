import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// This is an allowlist for process plumbing only. Do not add ambient OP_* auth
// variables here; they can switch `op` away from agent-vm's service account token.
const opCliProcessPlumbingEnvNames = [
	'APPDATA',
	'ALL_PROXY',
	'all_proxy',
	'COMSPEC',
	'HOME',
	'HTTP_PROXY',
	'http_proxy',
	'HTTPS_PROXY',
	'https_proxy',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LOCALAPPDATA',
	'NO_PROXY',
	'no_proxy',
	'PATH',
	'SSL_CERT_DIR',
	'SSL_CERT_FILE',
	'TEMP',
	'TMP',
	'TMPDIR',
	'TZ',
	'USERPROFILE',
	'WINDIR',
	'XDG_RUNTIME_DIR',
] satisfies readonly string[];

function createOpCliServiceAccountEnv(
	serviceAccountToken: string,
	opConfigDir: string,
): Readonly<Record<string, string | undefined>> {
	const env: Record<string, string | undefined> = {};
	for (const envName of opCliProcessPlumbingEnvNames) {
		const envValue = process.env[envName];
		if (envValue !== undefined) {
			env[envName] = envValue;
		}
	}
	env.OP_BIOMETRIC_UNLOCK_ENABLED = 'false';
	env.OP_CACHE = 'false';
	env.OP_CONFIG_DIR = opConfigDir;
	env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccountToken;
	return env;
}

export async function withOpCliServiceAccountEnv<TResult>(
	serviceAccountToken: string,
	callback: (env: Readonly<Record<string, string | undefined>>) => Promise<TResult>,
): Promise<TResult> {
	const opConfigDirParent = tmpdir();
	await mkdir(opConfigDirParent, { recursive: true });
	const opConfigDir = await mkdtemp(path.join(opConfigDirParent, 'agent-vm-op-config-'));
	try {
		return await callback(createOpCliServiceAccountEnv(serviceAccountToken, opConfigDir));
	} finally {
		await rm(opConfigDir, { force: true, recursive: true });
	}
}
