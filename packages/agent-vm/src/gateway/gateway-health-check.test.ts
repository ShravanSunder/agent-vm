import { describe, expect, it, vi } from 'vitest';

import { buildGatewayHealthCommand, runGatewayHealthCheck } from './gateway-health-check.js';

describe('gateway health checks', () => {
	it('builds an in-VM HTTP probe command for a gateway health endpoint', () => {
		const command = buildGatewayHealthCommand({
			type: 'http',
			port: 18789,
			path: '/readyz',
		});

		expect(command).toBe(
			'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/readyz 2>/dev/null || true',
		);
	});

	it('classifies HTTP health probes by returned status code family', async () => {
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: '503',
		}));

		const result = await runGatewayHealthCheck({
			exec,
			healthCheck: {
				type: 'http',
				port: 18789,
				path: '/readyz',
			},
		});

		expect(result).toEqual({
			exitCode: 0,
			observation: 'http 503',
			ok: false,
			stderr: '',
			stdout: '503',
		});
	});

	it('classifies command health probes by process exit code', async () => {
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: '',
		}));

		const result = await runGatewayHealthCheck({
			exec,
			healthCheck: {
				type: 'command',
				command: 'test -f /tmp/READY',
			},
		});

		expect(result).toEqual({
			exitCode: 0,
			observation: 'exit 0',
			ok: true,
			stderr: '',
			stdout: '',
		});
		expect(exec).toHaveBeenCalledWith('test -f /tmp/READY');
	});
});
