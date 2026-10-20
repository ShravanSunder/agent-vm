#!/usr/bin/env node
import { startNodeHost } from '#node-host/node-host-startup';
import { createNodeHostDiagnosticLogger } from '#node-host/observability/node-host-diagnostics';
import {
	configureProcessLogging,
	createPortalServerLogger,
	type ProcessLoggingHandle,
} from '#node-host/observability/process-logging';

const configPath = process.argv[2];
if (configPath === undefined || process.argv.length !== 3) {
	process.stderr.write('Usage: tool-host-node <configuration.jsonc>\n');
	process.exitCode = 1;
} else {
	let logging: ProcessLoggingHandle | undefined;
	try {
		logging = await configureProcessLogging({ stderr: process.stderr });
		const host = await startNodeHost({
			configPath,
			secrets: {
				resolve: async (secret) => {
					if (secret.source !== 'environment')
						throw new Error('This credential requires an injected resolver.');
					const value = process.env[secret.name];
					if (value === undefined || value.length === 0)
						throw new Error('Configured credential is unavailable.');
					return value;
				},
			},
			onDiagnostic: createNodeHostDiagnosticLogger(createPortalServerLogger()),
		});
		if (host.http !== undefined)
			process.stdout.write(
				`${JSON.stringify({ event: 'ready', endpoint: host.http.endpoint.href })}\n`,
			);
		const retire = async (): Promise<void> => {
			try {
				await host.retire();
			} finally {
				await logging?.shutdown();
			}
		};
		for (const signal of ['SIGINT', 'SIGTERM'] as const)
			process.once(signal, () => {
				void retire().catch(() => {
					process.exitCode = 1;
				});
			});
		if (host.http === undefined)
			process.stdin.once('end', () => {
				void retire().catch(() => {
					process.exitCode = 1;
				});
			});
	} catch {
		await logging?.shutdown();
		process.stderr.write('Tool host startup refused.\n');
		process.exitCode = 1;
	}
}
