export interface HermesAgentDistributionPin {
	readonly containerImage: 'docker.io/nousresearch/hermes-agent@sha256:e0df6adebddf29b91112aefc999d4aaf6846c9eb544faca5672a16a13590ff79';
	readonly distributionName: 'hermes-agent';
	readonly projectVersion: '0.20.6';
	readonly pythonRequirement: '>=3.11,<3.14';
	readonly sourceRepository: 'https://github.com/NousResearch/hermes-agent.git';
	readonly sourceRevision: '5fc308a70719a83cccdbba4c0e39c23f5a8239d5';
}

/**
 * Exact upstream provenance for the packaged Hermes distribution.
 *
 * The source revision and OCI digest identify the exact upstream Docker
 * release. Overlay research may inspect newer upstream trees, but packaged
 * runtime proof remains anchored to this immutable image.
 */
export const HERMES_AGENT_DISTRIBUTION = Object.freeze({
	containerImage:
		'docker.io/nousresearch/hermes-agent@sha256:e0df6adebddf29b91112aefc999d4aaf6846c9eb544faca5672a16a13590ff79',
	distributionName: 'hermes-agent',
	projectVersion: '0.20.6',
	pythonRequirement: '>=3.11,<3.14',
	sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
	sourceRevision: '5fc308a70719a83cccdbba4c0e39c23f5a8239d5',
} satisfies HermesAgentDistributionPin);
