import path from 'node:path';

import {
	OPENCLAW_STATE_SANDBOXES_VM_ROOT,
	OPENCLAW_STATE_VM_ROOT,
	type RuntimePathMapping,
} from '@agent-vm/gateway-interface';

import { OPENCLAW_ZONE_FILES_GUEST_ROOT } from '../zone-git/zone-git-paths.js';

export { OPENCLAW_STATE_SANDBOXES_VM_ROOT, OPENCLAW_STATE_VM_ROOT };

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
				guidanceLabel: 'OpenClaw sandbox work directory',
				id: 'openclaw-sandboxes',
				locations: {
					'controller-host': path.join(options.stateDir, 'sandboxes'),
					'openclaw-gateway': OPENCLAW_STATE_SANDBOXES_VM_ROOT,
				},
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
				guidanceLabel: 'OpenClaw state workspace',
				id: 'openclaw-state',
				locations: {
					'controller-host': options.stateDir,
					'openclaw-gateway': OPENCLAW_STATE_VM_ROOT,
				},
				rootPathAllowed: false,
				showInGuidance: {
					'controller-host': false,
					'openclaw-gateway': false,
					'tool-vm-guest': false,
				},
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
				guidanceLabel: 'OpenClaw zone files',
				id: 'zone-files',
				locations: {
					'controller-host': options.zoneFilesDir,
					'openclaw-gateway': OPENCLAW_ZONE_FILES_GUEST_ROOT,
				},
				rootPathAllowed: false,
			},
		],
	};
}
