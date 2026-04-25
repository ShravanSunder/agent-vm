/**
 * TCP binding name that code inside the VM uses to reach a resource.
 *
 * The host is a logical VM hostname, not a Docker Compose service name. The
 * controller maps this binding to the selected external resource or repo-local
 * provider target.
 */
export interface ResourceBinding {
	/** Hostname visible from the VM, for example `pg.local`. */
	readonly host: string;

	/** TCP port visible from the VM. */
	readonly port: number;
}

/** Environment variables associated with one logical resource. */
export type ResourceEnv = Record<string, string>;

/**
 * Resource a repo needs in order to run its task.
 *
 * Requirements are keyed by logical resource name. Repos that require the same
 * name share one task-level resource, while different names such as `pg` and
 * `pg-blah` remain distinct.
 */
export interface RepoResourceRequirement {
	/** VM-facing binding that this repo expects to use. */
	readonly binding: ResourceBinding;

	/**
	 * Optional template or hint for variables the repo expects. Final values are
	 * produced by external resources or `finalizeRepoResourceSetup()`.
	 */
	readonly env?: ResourceEnv;
}

/**
 * Repo-local Docker Compose provider for a logical resource.
 *
 * The service name is local to this repo's Compose file. The logical resource
 * name is the key in `provides`, so two repos may both provide `pg` without
 * colliding in Docker.
 */
export interface ComposeResourceProvider {
	readonly type: 'compose';

	/** Service name from `.agent-vm/docker-compose.yml`. */
	readonly service: string;
}

/**
 * Describe-time contract exported by `.agent-vm/repo-resources.ts`.
 *
 * This phase must be cheap and side-effect free. It only declares what the repo
 * needs and what it can provide; actual setup happens later.
 */
export interface RepoResourcesDescription {
	/**
	 * Repo-relative setup script run once after this repo's selected Compose
	 * services are up. Defaults to `.agent-vm/run-setup.sh`.
	 *
	 * The script is repo-owned imperative bootstrap. It receives
	 * `COMPOSE_PROJECT_NAME` and `RESOURCE_OUTPUT_DIR`, not resource names or
	 * resolved host/port values.
	 */
	readonly setupCommand?: string;

	/** Logical resources this repo needs. */
	readonly requires?: Record<string, RepoResourceRequirement>;

	/** Logical resources this repo can provide from repo-local Compose services. */
	readonly provides?: Record<string, ComposeResourceProvider>;
}

/** Input passed to `finalizeRepoResourceSetup()` after providers are selected. */
export interface FinalizeRepoResourceSetupInput {
	/** Stable, human-readable repo id derived from the repo URL. */
	readonly repoId: string;

	/** Original repo URL from the Worker task request. */
	readonly repoUrl: string;

	/** Absolute path to the cloned repo root. */
	readonly repoDir: string;

	/** Absolute path where generated files and mocks must be written. */
	readonly outputDir: string;

	/** Resources selected for this repo, keyed by logical resource name. */
	readonly selectedResources: Record<
		string,
		{
			/** VM-facing binding requested by consumers. */
			readonly binding: ResourceBinding;

			/** Provider target discovered by the controller. */
			readonly target: ResourceBinding;
		}
	>;
}

/** Final resolved resource returned by `finalizeRepoResourceSetup()`. */
export interface FinalizedResource {
	/** VM-facing binding requested by consumers. */
	readonly binding: ResourceBinding;

	/** Provider target discovered by the controller. */
	readonly target: ResourceBinding;

	/** Final environment variables injected into the task VM. */
	readonly env?: ResourceEnv;
}

/**
 * Final setup output returned by `.agent-vm/repo-resources.ts`.
 *
 * Use this to publish resolved env vars and to tell the agent about generated
 * files or directories it should inspect.
 */
export interface RepoResourcesFinal {
	/** Final resolved resources keyed by logical resource name. */
	readonly resources?: Record<string, FinalizedResource>;

	/** Generated files or directories under `outputDir`. */
	readonly generated?: {
		readonly kind: 'file' | 'directory';

		/** Relative path under `outputDir`; traversal and absolute paths are rejected. */
		readonly path: string;

		/** Human-readable hint shown to agents and docs. */
		readonly description?: string | undefined;
	}[];
}
