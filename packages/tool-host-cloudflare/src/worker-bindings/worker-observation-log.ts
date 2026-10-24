import type { ObservationLog } from '@agent-collaboration/tool-host-core';

export function writeObservationLog(event: ObservationLog): void {
	const workerConsole = globalThis.console;
	workerConsole.info(JSON.stringify(event));
}
