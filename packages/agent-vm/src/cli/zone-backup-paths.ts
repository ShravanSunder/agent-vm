import os from 'node:os';
import path from 'node:path';

export function resolveZoneBackupDir(options: {
	readonly configuredBackupDir?: string | undefined;
	readonly zoneId: string;
}): string {
	return (
		options.configuredBackupDir ?? path.join(os.homedir(), '.agent-vm-backups', options.zoneId)
	);
}
