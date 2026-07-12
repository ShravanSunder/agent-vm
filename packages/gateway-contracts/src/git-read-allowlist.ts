function trimGitSuffix(repoPath: string): string {
	return repoPath.replace(/\.git$/u, '');
}

function normalizeRepoPath(repoPath: string): string | undefined {
	const trimmedRepoPath = trimGitSuffix(repoPath.trim().replace(/^\/+/u, ''));
	const segments = trimmedRepoPath.split('/');
	if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
		return undefined;
	}
	return trimmedRepoPath;
}

function normalizeHost(host: string): string | undefined {
	const normalizedHost = host.trim().toLowerCase();
	if (!/^[a-z0-9.-]+$/u.test(normalizedHost) || normalizedHost.startsWith('.')) {
		return undefined;
	}
	return normalizedHost;
}

export interface NormalizedGitSshReadAllowlistEntry {
	readonly host: string;
	readonly repoPath: string;
}

export interface NormalizedGitSshReadAllowlist {
	readonly allowedHosts: readonly string[];
	readonly allowedRepos: readonly string[];
}

export function normalizeGitRepoForSshReadAllowlist(
	repoUrl: string,
): NormalizedGitSshReadAllowlistEntry | undefined {
	const trimmedRepoUrl = repoUrl.trim();
	if (trimmedRepoUrl.length === 0) {
		return undefined;
	}

	let parsedUrl: URL | undefined;
	try {
		parsedUrl = new URL(trimmedRepoUrl);
	} catch {
		parsedUrl = undefined;
	}
	if (parsedUrl !== undefined) {
		const host = normalizeHost(parsedUrl.hostname);
		const repoPath = normalizeRepoPath(parsedUrl.pathname);
		return host === undefined || repoPath === undefined ? undefined : { host, repoPath };
	}

	const scpMatch = /^(?:[^@]+@)?(?<host>[A-Za-z0-9.-]+):(?<repoPath>[^:]+)$/u.exec(trimmedRepoUrl);
	if (scpMatch?.groups?.host !== undefined && scpMatch.groups.repoPath !== undefined) {
		const host = normalizeHost(scpMatch.groups.host);
		const repoPath = normalizeRepoPath(scpMatch.groups.repoPath);
		return host === undefined || repoPath === undefined ? undefined : { host, repoPath };
	}

	const hostPathMatch = /^(?<host>[A-Za-z0-9.-]+)\/(?<repoPath>.+)$/u.exec(trimmedRepoUrl);
	if (hostPathMatch?.groups?.host !== undefined && hostPathMatch.groups.repoPath !== undefined) {
		const repoPathWithoutHost = normalizeRepoPath(hostPathMatch.groups.repoPath);
		const host = normalizeHost(hostPathMatch.groups.host);
		if (host !== undefined && repoPathWithoutHost !== undefined && host.includes('.')) {
			return { host, repoPath: repoPathWithoutHost };
		}
	}

	const bareRepoPath = normalizeRepoPath(trimmedRepoUrl);
	if (bareRepoPath !== undefined) {
		return { host: 'github.com', repoPath: bareRepoPath };
	}

	return undefined;
}

export function normalizeGitReposForSshReadAllowlist(
	repoUrls: readonly string[] | undefined,
): NormalizedGitSshReadAllowlist {
	if (repoUrls === undefined) {
		return { allowedHosts: [], allowedRepos: [] };
	}
	const allowedHosts = new Set<string>();
	const allowedRepos = new Set<string>();
	for (const repoUrl of repoUrls) {
		const normalizedRepo = normalizeGitRepoForSshReadAllowlist(repoUrl);
		if (normalizedRepo !== undefined) {
			allowedHosts.add(normalizedRepo.host);
			allowedRepos.add(normalizedRepo.repoPath);
		}
	}
	return {
		allowedHosts: [...allowedHosts].toSorted(),
		allowedRepos: [...allowedRepos].toSorted(),
	};
}

export function normalizeGitHubRepoForSshReadAllowlist(repoUrl: string): string | undefined {
	const trimmedRepoUrl = repoUrl.trim();
	if (trimmedRepoUrl.length === 0) {
		return undefined;
	}

	const scpMatch = /^git@github\.com:(?<repoPath>[^:]+\/[^/]+)$/iu.exec(trimmedRepoUrl);
	if (scpMatch?.groups?.repoPath !== undefined) {
		return normalizeRepoPath(scpMatch.groups.repoPath);
	}

	const hostPathMatch = /^(?:github\.com\/)(?<repoPath>[^/]+\/[^/]+)$/iu.exec(trimmedRepoUrl);
	if (hostPathMatch?.groups?.repoPath !== undefined) {
		return normalizeRepoPath(hostPathMatch.groups.repoPath);
	}

	const bareRepoPath = normalizeRepoPath(trimmedRepoUrl);
	if (bareRepoPath !== undefined) {
		return bareRepoPath;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(trimmedRepoUrl);
	} catch {
		return undefined;
	}
	if (parsedUrl.hostname.toLowerCase() !== 'github.com') {
		return undefined;
	}
	return normalizeRepoPath(parsedUrl.pathname);
}

export function normalizeGitHubReposForSshReadAllowlist(
	repoUrls: readonly string[] | undefined,
): readonly string[] {
	return normalizeGitReposForSshReadAllowlist(repoUrls).allowedRepos;
}
