import { randomBytes, timingSafeEqual } from 'node:crypto';

export const ZONE_GIT_CAPABILITY_HEADER = 'x-agent-vm-zone-git-token';
export const ZONE_GIT_CAPABILITY_ENV_VAR = 'AGENT_VM_ZONE_GIT_TOKEN';

export type ZoneGitRuntimePluginConfig = Readonly<
	Record<string, Readonly<Record<string, unknown>>>
>;

export interface ZoneGitCapabilityStoreProps {
	readonly generateToken?: () => string;
}

function generateDefaultToken(): string {
	return randomBytes(32).toString('base64url');
}

function constantTimeStringEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class ZoneGitCapabilityStore {
	private readonly generateToken: () => string;
	private readonly tokensByZoneId = new Map<string, string>();

	public constructor(props: ZoneGitCapabilityStoreProps = {}) {
		this.generateToken = props.generateToken ?? generateDefaultToken;
	}

	public issueTokenForZone(zoneId: string): string {
		const existingToken = this.tokensByZoneId.get(zoneId);
		if (existingToken) {
			return existingToken;
		}
		const token = this.generateToken();
		this.tokensByZoneId.set(zoneId, token);
		return token;
	}

	public buildRuntimePluginConfig(zoneId: string): ZoneGitRuntimePluginConfig {
		this.issueTokenForZone(zoneId);
		return {
			gondolin: {
				zoneGitTokenEnv: ZONE_GIT_CAPABILITY_ENV_VAR,
			},
		};
	}

	public buildRuntimeEnvironment(zoneId: string): Readonly<Record<string, string>> {
		return {
			[ZONE_GIT_CAPABILITY_ENV_VAR]: this.issueTokenForZone(zoneId),
		};
	}

	public verifyTokenForZone(zoneId: string, token: string | undefined): boolean {
		const expectedToken = this.tokensByZoneId.get(zoneId);
		return (
			expectedToken !== undefined &&
			token !== undefined &&
			constantTimeStringEquals(token, expectedToken)
		);
	}
}
