import {
	isAgentVmHealthEvent,
	type AgentChannelProviderHealthDetails,
	type AgentChannelProviderHealthKind,
	type AgentVmHealthEvent,
	type AgentVmHealthResultKind,
} from '@agent-vm/gateway-interface';

type AgentChannelProviderHealthEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'agent-channel-provider-health' }
>;

export interface BuildAgentChannelProviderHealthEventOptions {
	readonly channelProviderId: string;
	readonly details?: AgentChannelProviderHealthDetails | undefined;
	readonly health: AgentChannelProviderHealthKind;
	readonly observedAtMs: number;
	readonly transitionStartedAtMs?: number | undefined;
	readonly unhealthySinceMs?: number | undefined;
	readonly zoneId: string;
}

export function buildAgentChannelProviderHealthEvent(
	options: BuildAgentChannelProviderHealthEventOptions,
): AgentChannelProviderHealthEvent {
	const event = {
		channelProviderId: options.channelProviderId,
		...(options.details === undefined ? {} : { details: options.details }),
		health: options.health,
		kind: 'agent-channel-provider-health',
		observedAtMs: options.observedAtMs,
		result: resultForChannelProviderHealth(options.health),
		...(options.transitionStartedAtMs === undefined
			? {}
			: { transitionStartedAtMs: options.transitionStartedAtMs }),
		...(options.unhealthySinceMs === undefined
			? {}
			: { unhealthySinceMs: options.unhealthySinceMs }),
		zoneId: options.zoneId,
	} satisfies AgentChannelProviderHealthEvent;
	if (!isAgentVmHealthEvent(event)) {
		throw new Error(
			'Channel-provider health event requires whitelisted and redacted channel-provider health details.',
		);
	}
	return event;
}

function resultForChannelProviderHealth(
	health: AgentChannelProviderHealthKind,
): AgentVmHealthResultKind {
	switch (health) {
		case 'healthy':
		case 'transitioning':
			return 'ok';
		case 'unhealthy-recoverable':
		case 'unhealthy-unrecoverable':
			return 'failed';
	}
	return assertNeverAgentChannelProviderHealth(health);
}

function assertNeverAgentChannelProviderHealth(health: never): never {
	throw new Error(`Unhandled agent channel provider health: ${String(health)}`);
}
