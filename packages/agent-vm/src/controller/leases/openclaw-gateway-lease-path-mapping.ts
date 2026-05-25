import path from 'node:path';

import type { RuntimePathMapping } from '@agent-vm/gateway-interface';

import { OPENCLAW_ZONE_FILES_GUEST_ROOT } from '../zone-git/zone-git-paths.js';

export const OPENCLAW_STATE_VM_ROOT = '/home/openclaw/.openclaw/state';
export const OPENCLAW_STATE_SANDBOXES_VM_ROOT = `${OPENCLAW_STATE_VM_ROOT}/sandboxes`;

export function createOpenClawGatewayLeasePathMapping(options: {
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}): RuntimePathMapping {
	return {
		id: 'openclaw-gateway-lease',
		roots: [
			{
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				guestRoot: OPENCLAW_STATE_SANDBOXES_VM_ROOT,
				guidanceLabel: 'OpenClaw sandbox work directory',
				hostRoot: path.join(options.stateDir, 'sandboxes'),
				id: 'openclaw-sandboxes',
				rootPathAllowed: false,
			},
			{
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: false,
					leaseMount: true,
				},
				guestRoot: OPENCLAW_ZONE_FILES_GUEST_ROOT,
				guidanceLabel: 'OpenClaw zone files',
				hostRoot: options.zoneFilesDir,
				id: 'zone-files',
				rootPathAllowed: false,
			},
		],
	};
}
