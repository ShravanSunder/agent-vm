import {
	type HeartbeatHandle,
	type HeartbeatSenderProps,
	startHeartbeatSender as startHeartbeatSenderDefault,
} from './heartbeat-sender.js';

interface ActiveRequestHeartbeat {
	readonly callerUrl: string;
	readonly handle: HeartbeatHandle;
	readonly refCount: number;
}

export interface RequestHeartbeatRegistryProps {
	readonly startHeartbeatSender?: (
		requestTaskId: string,
		props: HeartbeatSenderProps,
	) => HeartbeatHandle;
	readonly logWarning?: (message: string) => void;
}

function defaultLogWarning(message: string): void {
	process.stderr.write(`[request-heartbeat-registry] ${message}\n`);
}

export class RequestHeartbeatRegistry {
	private readonly activeHeartbeats = new Map<string, ActiveRequestHeartbeat>();
	private readonly startHeartbeatSender: (
		requestTaskId: string,
		props: HeartbeatSenderProps,
	) => HeartbeatHandle;
	private readonly logWarning: (message: string) => void;

	public constructor(props: RequestHeartbeatRegistryProps = {}) {
		this.startHeartbeatSender = props.startHeartbeatSender ?? startHeartbeatSenderDefault;
		this.logWarning = props.logWarning ?? defaultLogWarning;
	}

	public acquire(requestTaskId: string, callerUrl: string): void {
		const activeHeartbeat = this.activeHeartbeats.get(requestTaskId);
		if (activeHeartbeat) {
			if (activeHeartbeat.callerUrl !== callerUrl) {
				throw new Error(
					`Heartbeat for request task '${requestTaskId}' is already bound to '${activeHeartbeat.callerUrl}', cannot acquire '${callerUrl}'.`,
				);
			}
			this.activeHeartbeats.set(requestTaskId, {
				...activeHeartbeat,
				refCount: activeHeartbeat.refCount + 1,
			});
			return;
		}

		this.activeHeartbeats.set(requestTaskId, {
			callerUrl,
			handle: this.startHeartbeatSender(requestTaskId, { callerUrl }),
			refCount: 1,
		});
	}

	public release(requestTaskId: string): void {
		const activeHeartbeat = this.activeHeartbeats.get(requestTaskId);
		if (!activeHeartbeat) {
			this.logWarning(`release called for unknown request task '${requestTaskId}'`);
			return;
		}
		if (activeHeartbeat.refCount > 1) {
			this.activeHeartbeats.set(requestTaskId, {
				...activeHeartbeat,
				refCount: activeHeartbeat.refCount - 1,
			});
			return;
		}
		activeHeartbeat.handle.stop();
		this.activeHeartbeats.delete(requestTaskId);
	}

	public stopAll(): void {
		for (const activeHeartbeat of this.activeHeartbeats.values()) {
			activeHeartbeat.handle.stop();
		}
		this.activeHeartbeats.clear();
	}
}
