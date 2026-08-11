export interface HermesAgentDistributionPin {
	readonly containerImage: 'docker.io/nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e';
	readonly distributionName: 'hermes-agent';
	readonly projectVersion: '0.20.0';
	readonly pythonRequirement: '>=3.11,<3.14';
	readonly sourceRepository: 'https://github.com/NousResearch/hermes-agent.git';
	readonly sourceRevision: '3c27eb6234bf91b8ceee9e9071591b31e9b148cb';
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
		'docker.io/nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e',
	distributionName: 'hermes-agent',
	projectVersion: '0.20.0',
	pythonRequirement: '>=3.11,<3.14',
	sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
	sourceRevision: '3c27eb6234bf91b8ceee9e9071591b31e9b148cb',
} satisfies HermesAgentDistributionPin);
