/* oxlint-disable no-console, no-await-in-loop, id-length, no-control-regex */
/**
 * Live manual sandbox test — boots full stack with channels + sandbox plugin.
 *
 * Run: node scripts/live-sandbox-manual.mjs
 * Requires: QEMU, built gateway image, .env.local with OP_SERVICE_ACCOUNT_TOKEN
 */
import fs from 'node:fs';
import http from 'node:http';

import { createSecretResolver } from '../packages/gondolin-core/dist/secret-resolver.js';
import { createManagedVm } from '../packages/gondolin-core/dist/vm-adapter.js';

// Dynamic import for Gondolin SDK (needs the full path)
const gondolin =
	await import('/Users/shravansunder/Documents/dev/open-source/vm/gondolin/host/dist/src/index.js');
const { VM, createHttpHooks, RealFSProvider, ReadonlyProvider } = gondolin;

// Load .env.local
const envLocal = fs.readFileSync('.env.local', 'utf-8');
for (const line of envLocal.split('\n')) {
	const [key, ...rest] = line.split('=');
	if (key && rest.length > 0) process.env[key.trim()] = rest.join('=').trim();
}

const t0 = Date.now();
const log = (msg) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${msg}`);

// --- Resolve secrets ---
const resolver = await createSecretResolver({
	serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
});
const discordToken = await resolver.resolve({
	source: '1password',
	ref: 'op://agent-vm/agent-discord-app/bot-token',
});
const perplexityKey = await resolver.resolve({
	source: '1password',
	ref: 'op://agent-vm/agent-perplexity/credential',
});
log('secrets resolved');

// --- Create tool VM ---
log('creating tool VM...');
const toolVm = await createManagedVm({
	imagePath: '',
	memory: '512M',
	cpus: 1,
	rootfsMode: 'cow',
	allowedHosts: ['api.github.com', 'registry.npmjs.org'],
	secrets: {},
	vfsMounts: {},
});
const toolSsh = await toolVm.enableSsh({
	user: 'root',
	listenHost: '127.0.0.1',
	listenPort: 19000,
});
await toolVm.exec('echo TOOL_VM_READY > /tmp/marker.txt');
const identityPem = fs.readFileSync(toolSsh.identityFile, 'utf-8');
log(`tool VM ready on port ${toolSsh.port}`);

// --- Controller lease API (plain Node.js HTTP) ---
const server = http.createServer((req, res) => {
	void (async () => {
		res.setHeader('Content-Type', 'application/json');

		if (req.method === 'GET' && req.url === '/health') {
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		if (req.method === 'POST' && req.url === '/lease') {
			log('>>> LEASE REQUESTED — tool VM assigned');
			res.end(
				JSON.stringify({
					leaseId: 'live-lease-001',
					ssh: { host: 'tool-0.vm.host', port: 22, user: 'root', identityPem, knownHostsLine: '' },
					workdir: '/tmp',
					tcpSlot: 0,
				}),
			);
			return;
		}

		if (req.method === 'DELETE' && req.url?.startsWith('/lease/')) {
			log(`>>> LEASE RELEASED: ${req.url.split('/').pop()}`);
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		res.statusCode = 404;
		res.end(JSON.stringify({ error: 'not found' }));
	})();
});
server.listen(18800);
log('controller API on :18800');

// --- HTTP mediation for REST API secrets ---
const { httpHooks, env } = createHttpHooks({
	allowedHosts: [
		'api.perplexity.ai',
		'api.anthropic.com',
		'statsig.anthropic.com',
		'sentry.io',
		'api.openai.com',
		'auth.openai.com',
		'discord.com',
		'cdn.discordapp.com',
		'registry.npmjs.org',
		'clawhub.ai',
		'openclaw.ai',
		'docs.openclaw.ai',
	],
	secrets: {
		PERPLEXITY_API_KEY: { hosts: ['api.perplexity.ai'], value: perplexityKey },
	},
});

// --- Config ---
// Use persisted state from previous sessions (has WhatsApp creds, Codex OAuth, etc.)
const cfgDir = '/tmp/oc-persistent/config';
const stateDir = '/tmp/oc-persistent/state';
const wsDir = '/tmp/oc-persistent/workspace';
[cfgDir, stateDir, wsDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const pluginDir = `${process.cwd()}/packages/openclaw-agent-vm-plugin/dist`;

// Patch existing config or create fresh one
const existingConfig = fs.existsSync(`${cfgDir}/openclaw.json`)
	? JSON.parse(fs.readFileSync(`${cfgDir}/openclaw.json`, 'utf-8'))
	: {
			gateway: { port: 18789, mode: 'local', bind: 'loopback', auth: { mode: 'token' } },
			agents: {
				defaults: {
					workspace: '/home/openclaw/workspace',
					model: { primary: 'openai-codex/gpt-5.4' },
				},
			},
			channels: { whatsapp: {}, discord: {} },
		};
existingConfig.agents = existingConfig.agents || {};
existingConfig.agents.defaults = existingConfig.agents.defaults || {};
existingConfig.agents.defaults.sandbox = { mode: 'all', backend: 'gondolin', scope: 'session' };
existingConfig.tools = existingConfig.tools || {};
existingConfig.tools.elevated = { enabled: false };
existingConfig.plugins = existingConfig.plugins || {};
existingConfig.plugins.entries = existingConfig.plugins.entries || {};
existingConfig.plugins.entries.gondolin = {
	enabled: true,
	config: { controllerUrl: 'http://controller.vm.host:18800', zoneId: 'shravan' },
};
// loadPaths removed — using OPENCLAW_BUNDLED_PLUGINS_DIR env var instead
fs.writeFileSync(`${cfgDir}/openclaw.json`, JSON.stringify(existingConfig, null, 2));

// --- Boot gateway VM ---
log('booting gateway VM...');
const gatewayVm = await VM.create({
	sandbox: { imagePath: './build-cache/gateway' },
	memory: '2G',
	cpus: 2,
	httpHooks,
	dns: { mode: 'synthetic', syntheticHostMapping: 'per-host' },
	tcp: {
		hosts: {
			'controller.vm.host:18800': '127.0.0.1:18800',
			'tool-0.vm.host:22': '127.0.0.1:19000',
			'gateway.discord.gg:443': 'gateway.discord.gg:443',
			'web.whatsapp.com:443': 'web.whatsapp.com:443',
			'g.whatsapp.net:443': 'g.whatsapp.net:443',
			'mmg.whatsapp.net:443': 'mmg.whatsapp.net:443',
		},
	},
	env: {
		...env,
		HOME: '/home/openclaw',
		OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw',
		DISCORD_BOT_TOKEN: discordToken,
		OPENCLAW_BUNDLED_PLUGINS_DIR: '/opt/extensions',
	},
	vfs: {
		mounts: {
			'/home/openclaw/.openclaw': new RealFSProvider(cfgDir),
			'/home/openclaw/.openclaw/state': new RealFSProvider(stateDir),
			'/home/openclaw/workspace': new RealFSProvider(wsDir),
			// Mount plugin at staging path — will be copied to extensions with correct ownership
			'/opt/gondolin-plugin-src': new ReadonlyProvider(new RealFSProvider(pluginDir)),
		},
	},
});

// Copy plugin to rootfs /opt/extensions/gondolin/ with root ownership.
// OPENCLAW_BUNDLED_PLUGINS_DIR points to /opt/extensions.
await gatewayVm.exec(
	'mkdir -p /opt/extensions/gondolin && ' +
		'cp -a /opt/gondolin-plugin-src/. /opt/extensions/gondolin/ && ' +
		'chown -R root:root /opt/extensions',
);
const pluginCheck = await gatewayVm.exec(
	"stat -c '%U' /opt/extensions/gondolin/plugin.js 2>/dev/null || echo no-stat",
);
log('plugin ownership: ' + pluginCheck.stdout.trim());

await gatewayVm.exec(
	'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
);
log('gateway starting...');

// Wait for ready
for (let i = 0; i < 30; i++) {
	const c = await gatewayVm.exec(
		`curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/ 2>/dev/null || echo 000`,
	);
	if (c.stdout.trim() !== '000') {
		log('gateway ready');
		break;
	}
	await new Promise((r) => setTimeout(r, 500));
}

// Wait for channels
await new Promise((r) => setTimeout(r, 10000));
const logs = await gatewayVm.exec(
	`grep -iE "discord|whatsapp|gondolin|sandbox|plugin|error" /tmp/openclaw.log 2>/dev/null | tail -15`,
);
log('=== Startup logs ===');
console.log(logs.stdout.replace(/\x1b\[[0-9;]*m/g, ''));

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  LIVE: Gateway + Tool VM + Controller running');
console.log('  Send a WhatsApp message or @sunfam-claw on Discord.');
console.log('  Ask: "run ls -la" or "what files are in /tmp"');
console.log('  Watch this terminal for LEASE requests.');
console.log('  Alive for 15 minutes.');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Keep alive, print status
for (let i = 0; i < 15; i++) {
	await new Promise((r) => setTimeout(r, 60000));
	const tail = await gatewayVm.exec('tail -3 /tmp/openclaw.log 2>/dev/null');
	const lastLine = tail.stdout
		.replace(/\x1b\[[0-9;]*m/g, '')
		.trim()
		.split('\n')
		.pop();
	log(`[${i + 1}m] ${lastLine}`);
}

await gatewayVm.close();
await toolVm.close();
server.close();
log('done');
