import type {
	ExternalResources,
	ResourceBinding,
	RepoResourceRequirement,
	ResolvedComposeResourceProvider,
	ResolvedRepoResourcesDescription,
	ZoneResourcesPolicy,
} from '../config/resource-contracts/index.js';

export interface RepoResourceDescriptionInput {
	readonly description: ResolvedRepoResourcesDescription;
	readonly repoId: string;
	readonly repoUrl: string;
}

export interface SelectedRepoResourceProvider {
	readonly binding: RepoResourceRequirement['binding'];
	readonly provider: ResolvedComposeResourceProvider;
	readonly repoId: string;
	readonly repoUrl: string;
	readonly resourceName: string;
	readonly setupCommand: string;
}

export interface ResolveTaskResourcesOptions {
	readonly allowRepoResources: ZoneResourcesPolicy['allowRepoResources'];
	readonly externalResources: ExternalResources;
	readonly repos: readonly RepoResourceDescriptionInput[];
}

export interface ResolvedTaskResources {
	readonly externalResources: ExternalResources;
	readonly selectedRepoProviders: readonly SelectedRepoResourceProvider[];
}

function isRepoAllowed(
	allowRepoResources: ZoneResourcesPolicy['allowRepoResources'],
	repoUrl: string,
): boolean {
	if (allowRepoResources === true) {
		return true;
	}
	if (allowRepoResources === false) {
		return false;
	}
	const normalizedRepoUrl = normalizeRepoUrl(repoUrl, 'repo resource provider URL');
	return allowRepoResources.some(
		(allowedRepoUrl) =>
			normalizeRepoUrl(allowedRepoUrl, 'repo resource allow-list URL') === normalizedRepoUrl,
	);
}

function normalizeRepoUrl(repoUrl: string, label: string): string {
	try {
		const parsedUrl = new URL(repoUrl);
		parsedUrl.hash = '';
		parsedUrl.search = '';
		parsedUrl.hostname = parsedUrl.hostname.toLowerCase();
		parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
		return parsedUrl.toString().replace(/\/$/u, '');
	} catch {
		throw new Error(`Invalid ${label}: '${repoUrl}'.`);
	}
}

function bindingsMatch(left: ResourceBinding, right: ResourceBinding): boolean {
	return left.host === right.host && left.port === right.port;
}

function describeBinding(binding: ResourceBinding): string {
	return `${binding.host}:${String(binding.port)}`;
}

function resolveRequiredBinding(options: {
	readonly resourceName: string;
	readonly repos: readonly RepoResourceDescriptionInput[];
}): ResourceBinding {
	const requirements = options.repos.flatMap((repo) => {
		const requirement = repo.description.requires[options.resourceName];
		return requirement ? [{ repo, requirement }] : [];
	});
	const firstRequirement = requirements[0]?.requirement;
	if (!firstRequirement) {
		throw new Error(`Required resource '${options.resourceName}' disappeared during resolution.`);
	}
	for (const { repo, requirement } of requirements.slice(1)) {
		if (!bindingsMatch(firstRequirement.binding, requirement.binding)) {
			throw new Error(
				`Resource '${options.resourceName}' has conflicting bindings: ` +
					`${describeBinding(firstRequirement.binding)} and ` +
					`${describeBinding(requirement.binding)} from '${repo.repoUrl}'.`,
			);
		}
	}
	return firstRequirement.binding;
}

export function resolveTaskResources(options: ResolveTaskResourcesOptions): ResolvedTaskResources {
	const requiredResourceNames = new Set<string>();
	for (const repo of options.repos) {
		for (const resourceName of Object.keys(repo.description.requires)) {
			requiredResourceNames.add(resourceName);
		}
	}

	const selectedRepoProviders: SelectedRepoResourceProvider[] = [];
	for (const resourceName of requiredResourceNames) {
		const requiredBinding = resolveRequiredBinding({ resourceName, repos: options.repos });
		const externalResource = options.externalResources[resourceName];
		if (externalResource) {
			if (!bindingsMatch(requiredBinding, externalResource.binding)) {
				throw new Error(
					`External resource '${resourceName}' binding ${describeBinding(
						externalResource.binding,
					)} does not match required binding ${describeBinding(requiredBinding)}.`,
				);
			}
			continue;
		}

		const providerRepo = options.repos.find((repo) => repo.description.provides[resourceName]);
		if (!providerRepo) {
			throw new Error(
				`Required resource '${resourceName}' has no external resource or repo provider.`,
			);
		}
		if (!isRepoAllowed(options.allowRepoResources, providerRepo.repoUrl)) {
			throw new Error(
				`Repo resource '${resourceName}' from '${providerRepo.repoUrl}' is not allowed by zone policy.`,
			);
		}

		const provider = providerRepo.description.provides[resourceName];
		if (!provider) {
			throw new Error(
				`Required resource '${resourceName}' provider disappeared during resolution.`,
			);
		}
		selectedRepoProviders.push({
			binding: requiredBinding,
			provider,
			repoId: providerRepo.repoId,
			repoUrl: providerRepo.repoUrl,
			resourceName,
			setupCommand: providerRepo.description.setupCommand,
		});
	}

	return {
		externalResources: options.externalResources,
		selectedRepoProviders,
	};
}
