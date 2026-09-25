export interface HermesAgentDistributionPin {
	readonly containerImage: 'docker.io/nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7';
	readonly distributionName: 'hermes-agent';
	readonly projectVersion: '0.21.5';
	readonly pythonRequirement: '>=3.11,<3.14';
	readonly sourceRepository: 'https://github.com/NousResearch/hermes-agent.git';
	readonly sourceRevision: 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
}

/**
 * Exact upstream provenance for the packaged Hermes distribution.
 *
 * The source revision and OCI digest identify the exact upstream Docker
 * release. Packaged runtime proof remains anchored to this immutable image.
 */
export const HERMES_AGENT_DISTRIBUTION = Object.freeze({
	containerImage:
		'docker.io/nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7',
	distributionName: 'hermes-agent',
	projectVersion: '0.21.5',
	pythonRequirement: '>=3.11,<3.14',
	sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
	sourceRevision: 'f97608f178d1ffeca59860195ab7da295f7c8e5f',
} satisfies HermesAgentDistributionPin);
