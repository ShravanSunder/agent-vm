import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveZoneBackupDir } from './zone-backup-paths.js';

describe('resolveZoneBackupDir', () => {
	it('keeps implicit backup fallback outside state and scoped by project namespace', () => {
		expect(
			resolveZoneBackupDir({
				projectNamespace: 'claw-tests-a1b2c3d4',
				zoneId: 'shravan',
			}),
		).toBe(path.join(os.homedir(), '.agent-vm-backups', 'claw-tests-a1b2c3d4', 'shravan'));
	});

	it('uses an explicitly configured backupDir unchanged', () => {
		expect(
			resolveZoneBackupDir({
				configuredBackupDir: '/var/agent-vm/backups/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				zoneId: 'shravan',
			}),
		).toBe('/var/agent-vm/backups/shravan');
	});
});
