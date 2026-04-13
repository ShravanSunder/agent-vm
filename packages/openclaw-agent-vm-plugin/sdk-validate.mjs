#!/usr/bin/env node
/**
 * Runtime SDK validation — run this INSIDE a gateway VM to verify
 * our plugin's type guard matches the actual OpenClaw SDK exports.
 *
 * Usage (inside VM):
 *   node /opt/extensions/gondolin/sdk-validate.mjs
 *
 * Exit 0 = compatible, Exit 1 = mismatch (lists missing exports)
 */
const SDK_PATH = '/opt/openclaw-sdk/sandbox.js';

const REQUIRED_EXPORTS = [
	'buildExecRemoteCommand',
	'buildRemoteCommand',
	'buildSshSandboxArgv',
	'createSshSandboxSessionFromSettings',
	'runSshSandboxCommand',
	'sanitizeEnvVars',
	'registerSandboxBackend',
];

try {
	const sdk = await import(SDK_PATH);
	const missing = REQUIRED_EXPORTS.filter((name) => typeof sdk[name] !== 'function');

	if (missing.length > 0) {
		process.stderr.write(`SDK MISMATCH - missing exports: ${missing.join(', ')}\n`);
		process.stderr.write('Update assertSdkShape() and SshHelpers interface in plugin.ts\n');
		process.exit(1);
	}

	process.stdout.write(
		`SDK COMPATIBLE - all ${String(REQUIRED_EXPORTS.length)} required exports found\n`,
	);
	process.exit(0);
} catch (error) {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	process.stderr.write(`SDK LOAD FAILED: ${message}\n`);
	process.stderr.write(`Is OpenClaw installed? Expected at: ${SDK_PATH}\n`);
	process.exit(1);
}
