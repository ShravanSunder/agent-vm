export interface HermesAgentDistributionPin {
	readonly distributionName: 'hermes-agent';
	readonly projectVersion: '0.18.2';
	readonly pythonRequirement: '>=3.11,<3.14';
	readonly sourceRepository: 'https://github.com/NousResearch/hermes-agent.git';
	readonly sourceRevision: '9de9c25f620ff7f1ce0fd5457d596052d5159596';
}

/**
 * Exact upstream provenance for the packaged Hermes distribution.
 *
 * The source revision is the release commit for the exact PyPI project
 * version. Overlay research may inspect newer upstream trees, but packaged
 * runtime proof must remain anchored to the code that the image installs.
 */
export const HERMES_AGENT_DISTRIBUTION = Object.freeze({
	distributionName: 'hermes-agent',
	projectVersion: '0.18.2',
	pythonRequirement: '>=3.11,<3.14',
	sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
	sourceRevision: '9de9c25f620ff7f1ce0fd5457d596052d5159596',
} satisfies HermesAgentDistributionPin);
