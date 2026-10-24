import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { exportJWK, generateKeyPair } from 'jose';
import { Miniflare, convertV4MiniflareOptions, type V4WorkerOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
import { z } from 'zod';

import { privateDeployFileSchema } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { renderDeployConfiguration } from '#worker-host/deployed-checks/deploy-configuration/render-deploy-configuration';
import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import {
	agentToken,
	portalCall,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';
import { runObservationsSchema } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

const executeFile = promisify(execFile);

/** Use Wrangler's actual deployment bundle and binding conversion, with synthetic inputs only. */
async function localDeploymentWorker(props: {
	readonly directory: string;
	readonly worker: 'portal-a' | 'test-helper';
}): Promise<V4WorkerOptions> {
	const configFile = path.join(props.directory, `${props.worker}.json`);
	const output = path.join(props.directory, `${props.worker}-bundle`);
	await executeFile(
		'pnpm',
		[
			'--filter',
			'@agent-collaboration/tool-host-cloudflare',
			'exec',
			'wrangler',
			'deploy',
			'--dry-run',
			'--config',
			configFile,
			'--outdir',
			output,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				WRANGLER_SEND_METRICS: 'false',
				WRANGLER_LOG_PATH: path.join(props.directory, `${props.worker}-wrangler.log`),
			},
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	const options = unstable_getMiniflareWorkerOptions(configFile);
	if (options.main === undefined) throw new Error('Rendered deployment has no entrypoint.');
	// Wrangler already bundled the module graph; source-discovery rules do not apply to that bundle.
	const { modulesRules: _sourceRules, ...bundleOptions } = options.workerOptions;
	const config = z
		.object({ name: z.string() })
		.parse(JSON.parse(await readFile(configFile, 'utf8')));
	const secrets = z
		.record(z.string(), z.string())
		.parse(
			JSON.parse(
				await readFile(path.join(props.directory, `${props.worker}.secrets.json`), 'utf8'),
			),
		);
	const variables = z.record(z.string(), z.string()).parse(options.workerOptions.bindings);
	return {
		...bundleOptions,
		name: config.name,
		modules: true,
		script: await readFile(path.join(output, `${path.basename(options.main, '.ts')}.js`), 'utf8'),
		bindings: { ...variables, ...secrets },
	};
}

it('negotiates with the actual deployed helper before an allowed portal call and one controlled effect', async () => {
	const guard = startWorkerdSocketGuard();
	const directory = await mkdtemp(path.join(tmpdir(), '2026-10-helper-portal-negotiation-'));
	let runtime: Miniflare | undefined;
	try {
		// Arrange: real deployment templates, fresh synthetic signing key, two real Worker heaps.
		const keys = await generateKeyPair('ES256', { extractable: true });
		const configuration = privateDeployFileSchema.parse({
			...privateDeployFixture(directory),
			privateSigningJwk: await exportJWK(keys.privateKey),
		});
		await renderDeployConfiguration(configuration, directory);
		const [portalOptions, helperOptions] = await Promise.all(
			(['portal-a', 'test-helper'] as const).map(async (worker) =>
				localDeploymentWorker({ directory, worker }),
			),
		);
		if (portalOptions === undefined || helperOptions === undefined)
			throw new Error('Missing local deployment Worker bundle.');
		runtime = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						...portalOptions,
						// Local-only network routing: keep helper/JWKS HTTPS URLs and all MCP wire code real.
						// This closed topology does not exercise public routing, Access or TLS deployment.
						outboundService: configuration.helper.name,
					},
					helperOptions,
				],
			}),
		);
		const helper = await runtime.getWorker(configuration.helper.name);
		const portal = await runtime.getWorker(configuration.portalA.name);
		const organization = configuration.organizations[0];
		const admission = await helper.fetch('https://helper.invalid/admission', {
			method: 'POST',
			headers: { authorization: `Bearer ${configuration.admissionSecret}` },
			body: JSON.stringify({
				organizationId: organization.organizationId,
				agentId: configuration.agentId,
				state: 'listed',
			}),
		});
		expect(admission.status).toBe(200);
		await admission.body?.cancel();
		const probe = await helper.fetch('https://helper.invalid/mcp/alpha', {
			method: 'POST',
			headers: { authorization: organization.credential },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'diagnostic-probe', method: 'server/discover' }),
		});
		const probeStatus = probe.status;
		const probeBody = await probe.text();
		// Act: the same allowed control used by deployed row 14, through the production portal entry.
		const callId = 'allowed-control';
		const response = await portal.fetch(
			`https://portal-a.invalid/workspaces/${organization.organizationId}/mcp`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${await agentToken(configuration)}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/call',
					'Mcp-Name': 'mcp_portal_call',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'allowed-control',
					method: 'tools/call',
					params: {
						...portalCall(configuration, callId),
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientCapabilities': {},
						},
					},
				}),
				signal: AbortSignal.timeout(90_000),
			},
		);
		const body: unknown = await response.json();
		const observationResponse = await helper.fetch(
			`https://helper.invalid/observations?runId=${configuration.runId}`,
			{
				method: 'GET',
				headers: { authorization: `Bearer ${configuration.admissionSecret}` },
			},
		);
		const observations = runObservationsSchema.parse(await observationResponse.json());
		process.stdout.write(
			`${JSON.stringify({ helperPortalProof: { probeStatus, probeBody, status: response.status, body, observations } })}\n`,
		);
		// Assert literal controlled output and durable own-credential effect, not transport status alone.
		expect(response.status).toBe(200);
		const result = z
			.object({
				result: z.object({
					isError: z.boolean().optional(),
					content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
				}),
			})
			.parse(body).result;
		expect(result.isError).not.toBe(true);
		const text = result.content[0]?.text;
		if (text === undefined) throw new Error('Allowed control has no projected result.');
		expect(JSON.parse(text)).toMatchObject({
			items: [
				{
					requestId: callId,
					status: 'success',
					structuredContent: {
						namespace: 'same-server',
						toolName: 'read',
						result: { content: [{ type: 'text', text: 'ok' }] },
					},
				},
			],
		});
		expect(observations.calls).toEqual([
			{
				organizationLabel: organization.label,
				callId,
				credential: organization.credential,
				toolName: 'read',
				effects: 1,
				inFlight: 0,
			},
		]);
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			await guard.stop();
			await rm(directory, { recursive: true, force: true });
		}
	}
}, 120_000);
