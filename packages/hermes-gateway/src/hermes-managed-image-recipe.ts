import { HERMES_AGENT_DISTRIBUTION } from './hermes-distribution.js';
import { managedHermesShellEnvironmentPath } from './hermes-shell-environment.js';

const HERMES_GATEWAY_PNPM_VERSION = '10.33.0';
const HERMES_GATEWAY_RUNTIME_HONO_VERSION = '4.12.24';
const HERMES_GATEWAY_RUNTIME_NODE_SERVER_VERSION = '2.0.4';
const HERMES_GATEWAY_CONTAINER_IMAGES: readonly [typeof HERMES_AGENT_DISTRIBUTION.containerImage] =
	[HERMES_AGENT_DISTRIBUTION.containerImage];

export interface HermesManagedImagePythonWheelFiles {
	readonly agentPortalSdk: string;
	readonly hermesAdapter: string;
}

export interface HermesManagedImageGatewayRuntimeArtifacts {
	readonly executablePath: string;
	readonly packageArchiveFiles: readonly string[];
	readonly packageManifestFile: string;
}

export interface HermesManagedImageLocalArtifactContext {
	readonly kind: 'local-artifact-context';
	readonly gatewayRuntime: HermesManagedImageGatewayRuntimeArtifacts;
	readonly pythonWheels: HermesManagedImagePythonWheelFiles;
}

export interface HermesManagedImagePublicRegistryContext {
	readonly agentVmVersion: string;
	readonly kind: 'public-registry-context';
}

export type HermesManagedImageArtifactContext =
	| HermesManagedImageLocalArtifactContext
	| HermesManagedImagePublicRegistryContext;

export interface HermesManagedImageBuildTarget {
	readonly architecture: 'aarch64' | 'x86_64';
	readonly kind: 'gondolin-custom-dockerfile';
	readonly ociImage: string;
	readonly rootfsSizeMb: number;
}

export interface RenderHermesManagedImageRecipeOptions {
	readonly artifactContext: HermesManagedImageArtifactContext;
	readonly buildTarget: HermesManagedImageBuildTarget;
}

export interface HermesManagedImageBuildConfig {
	readonly arch: HermesManagedImageBuildTarget['architecture'];
	readonly distro: 'alpine';
	readonly alpine: {
		readonly version: '3.23.0';
		readonly kernelPackage: 'linux-virt';
		readonly kernelImage: 'vmlinuz-virt';
		readonly rootfsPackages: readonly string[];
		readonly initramfsPackages: readonly string[];
	};
	readonly oci: {
		readonly image: string;
		readonly pullPolicy: 'never';
	};
	readonly rootfs: {
		readonly label: 'gondolin-root';
		readonly sizeMb: number;
	};
}

export interface HermesManagedImageBuildNetworkAccess {
	readonly aptPackages: 'public-debian-repositories';
	readonly containerImages: typeof HERMES_GATEWAY_CONTAINER_IMAGES;
	readonly kind: 'upstream-hermes-image-with-public-package-indexes';
	readonly npmPackages: 'public-npm-registry';
	readonly pythonPackages: 'public-python-package-index';
	readonly pythonRuntime: 'upstream-hermes-image';
}

export interface HermesManagedImageRecipe {
	readonly baseImage: typeof HERMES_AGENT_DISTRIBUTION.containerImage;
	readonly buildConfig: HermesManagedImageBuildConfig;
	readonly buildNetworkAccess: HermesManagedImageBuildNetworkAccess;
	readonly dockerfile: string;
	readonly frameworkBootEntry: 'hermes-gateway';
	readonly kind: 'hermes-managed-image-recipe';
	readonly sourceRevision: typeof HERMES_AGENT_DISTRIBUTION.sourceRevision;
}

function requireDockerContextFilePath(filePath: string, expectedExtension: string): string {
	const validRelativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
	if (!validRelativePathPattern.test(filePath) || !filePath.endsWith(expectedExtension)) {
		throw new Error(
			`Hermes image artifact '${filePath}' must be a relative Docker-context path ending in '${expectedExtension}'.`,
		);
	}
	return filePath;
}

function dockerContextFileName(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function requireAbsoluteGuestExecutablePath(filePath: string): string {
	const pathSegments = filePath.split('/');
	if (
		!filePath.startsWith('/') ||
		pathSegments
			.slice(1)
			.some(
				(pathSegment) => pathSegment.length === 0 || pathSegment === '.' || pathSegment === '..',
			) ||
		!/^[A-Za-z0-9._/@-]+$/u.test(filePath)
	) {
		throw new Error(
			`Hermes image Gateway Runtime executable '${filePath}' is not a safe guest path.`,
		);
	}
	return filePath;
}

function renderCopyLine(sourcePath: string, destinationDirectory: string): string {
	return `COPY ${sourcePath} ${destinationDirectory}/${dockerContextFileName(sourcePath)}`;
}

function requireExactPublicPackageVersion(packageVersion: string, packageName: string): string {
	const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
	if (!exactVersionPattern.test(packageVersion)) {
		throw new Error(
			`Hermes image public package '${packageName}' must use an exact numeric semantic version.`,
		);
	}
	return packageVersion;
}

function renderHermesManagedImageLocalArtifactInstallLines(
	artifactContext: HermesManagedImageLocalArtifactContext,
): readonly string[] {
	const packageManifestFile = requireDockerContextFilePath(
		artifactContext.gatewayRuntime.packageManifestFile,
		'.json',
	);
	if (dockerContextFileName(packageManifestFile) !== 'package.json') {
		throw new Error("Hermes image Gateway Runtime package manifest must be named 'package.json'.");
	}
	if (artifactContext.gatewayRuntime.packageArchiveFiles.length === 0) {
		throw new Error(
			'Hermes image Gateway Runtime artifacts must include at least one package archive.',
		);
	}
	const packageArchiveFiles = artifactContext.gatewayRuntime.packageArchiveFiles.map((filePath) =>
		requireDockerContextFilePath(filePath, '.tgz'),
	);
	const gatewayRuntimeExecutablePath = requireAbsoluteGuestExecutablePath(
		artifactContext.gatewayRuntime.executablePath,
	);
	const agentPortalSdkWheel = requireDockerContextFilePath(
		artifactContext.pythonWheels.agentPortalSdk,
		'.whl',
	);
	const hermesAdapterWheel = requireDockerContextFilePath(
		artifactContext.pythonWheels.hermesAdapter,
		'.whl',
	);
	const packageManifestFileName = dockerContextFileName(packageManifestFile);
	const agentPortalSdkWheelFileName = dockerContextFileName(agentPortalSdkWheel);
	const hermesAdapterWheelFileName = dockerContextFileName(hermesAdapterWheel);

	return [
		renderCopyLine(packageManifestFile, '/opt/agent-vm/local-packages'),
		...packageArchiveFiles.map((filePath) =>
			renderCopyLine(filePath, '/opt/agent-vm/local-packages'),
		),
		'RUN test -f /opt/agent-vm/local-packages/' + packageManifestFileName + ' && \\',
		'    cd /opt/agent-vm/local-packages && \\',
		'    pnpm install --prod --ignore-scripts && \\',
		`    gateway_runtime_bin="${gatewayRuntimeExecutablePath}" && \\`,
		'    test -f "$gateway_runtime_bin" && chmod 755 "$gateway_runtime_bin" && \\',
		'    ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime && \\',
		'    command -v agent-vm-gateway-runtime',
		'',
		renderCopyLine(agentPortalSdkWheel, '/tmp'),
		renderCopyLine(hermesAdapterWheel, '/tmp'),
		'RUN uv pip install --python /opt/hermes/.venv/bin/python \\',
		`      /tmp/${agentPortalSdkWheelFileName} \\`,
		`      /tmp/${hermesAdapterWheelFileName} && \\`,
		'    hermes_scripts="$(/opt/hermes/.venv/bin/python -c \'import sysconfig; print(sysconfig.get_path("scripts"))\')" && \\',
		'    test -x "$hermes_scripts/agent-vm-hermes-gateway" && \\',
		'    ln -sfn "$hermes_scripts/agent-vm-hermes-gateway" /usr/local/bin/agent-vm-hermes-gateway && \\',
		'    command -v agent-vm-hermes-gateway && \\',
		`    /opt/hermes/.venv/bin/python -c 'import importlib.metadata as metadata; assert metadata.version("${HERMES_AGENT_DISTRIBUTION.distributionName}") == "${HERMES_AGENT_DISTRIBUTION.projectVersion}"' && \\`,
		`    rm -f /tmp/${agentPortalSdkWheelFileName} /tmp/${hermesAdapterWheelFileName}`,
	];
}

function renderHermesManagedImagePublicRegistryInstallLines(
	artifactContext: HermesManagedImagePublicRegistryContext,
): readonly string[] {
	const agentVmVersion = requireExactPublicPackageVersion(
		artifactContext.agentVmVersion,
		'Agent VM registry package set',
	);
	const gatewayRuntimeExecutablePath =
		'/opt/agent-vm/registry-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js';
	const registryPackageManifest = JSON.stringify({
		dependencies: {
			'@agent-vm/gateway-runtime': agentVmVersion,
		},
		private: true,
		pnpm: {
			overrides: {
				'@hono/node-server': HERMES_GATEWAY_RUNTIME_NODE_SERVER_VERSION,
				hono: HERMES_GATEWAY_RUNTIME_HONO_VERSION,
			},
		},
	});

	return [
		'RUN mkdir -p /opt/agent-vm/registry-packages && \\',
		'    cd /opt/agent-vm/registry-packages && \\',
		`    printf '%s\\n' '${registryPackageManifest}' > package.json && \\`,
		'    pnpm install --prod --ignore-scripts --registry=https://registry.npmjs.org/ && \\',
		`    gateway_runtime_bin="${gatewayRuntimeExecutablePath}" && \\`,
		'    test -f "$gateway_runtime_bin" && chmod 755 "$gateway_runtime_bin" && \\',
		'    ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime && \\',
		'    command -v agent-vm-gateway-runtime',
		'',
		'RUN uv pip install --python /opt/hermes/.venv/bin/python \\',
		'      --exclude-newer-package agent-vm-agent-portal-sdk=false \\',
		'      --exclude-newer-package agent-vm-hermes-adapter=false \\',
		'      --default-index https://pypi.org/simple \\',
		`      'agent-vm-agent-portal-sdk==${agentVmVersion}' \\`,
		`      'agent-vm-hermes-adapter==${agentVmVersion}' && \\`,
		'    hermes_scripts="$(/opt/hermes/.venv/bin/python -c \'import sysconfig; print(sysconfig.get_path("scripts"))\')" && \\',
		'    test -x "$hermes_scripts/agent-vm-hermes-gateway" && \\',
		'    ln -sfn "$hermes_scripts/agent-vm-hermes-gateway" /usr/local/bin/agent-vm-hermes-gateway && \\',
		'    command -v agent-vm-hermes-gateway && \\',
		`    /opt/hermes/.venv/bin/python -c 'import importlib.metadata as metadata; assert metadata.version("agent-vm-agent-portal-sdk") == "${agentVmVersion}"; assert metadata.version("agent-vm-hermes-adapter") == "${agentVmVersion}"; assert metadata.version("${HERMES_AGENT_DISTRIBUTION.distributionName}") == "${HERMES_AGENT_DISTRIBUTION.projectVersion}"'`,
	];
}

function renderHermesTuiInstallCommand(): string {
	return 'RUN test -f /opt/hermes/ui-tui/dist/entry.js';
}

function renderHermesShellEnvironmentInstallCommand(): string {
	const environmentLines = [
		'export HERMES_HOME=/home/hermes/.hermes',
		'export HERMES_TUI_DIR=/opt/hermes/ui-tui',
		'export HOME=/home/hermes',
		'export PATH=/opt/hermes/.venv/bin:/opt/hermes/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
		'export TMPDIR=/work/tmp',
		'export TMP=/work/tmp',
		'export TEMP=/work/tmp',
		'export UV_CACHE_DIR=/work/cache/uv',
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
		'export REQUESTS_CA_BUNDLE=/run/gondolin/ca-certificates.crt',
		'export SSL_CERT_FILE=/run/gondolin/ca-certificates.crt',
	] as const;

	return [
		'RUN install -d -m 0755 /etc/profile.d && \\',
		"    printf '%s\\n' \\",
		...environmentLines.map(
			(environmentLine, index) =>
				`      '${environmentLine}'${
					index === environmentLines.length - 1
						? ` > ${managedHermesShellEnvironmentPath} && \\`
						: ' \\'
				}`,
		),
		`    chmod 0644 ${managedHermesShellEnvironmentPath}`,
	].join('\n');
}

function renderHermesManagedImageDockerfile(
	artifactContext: HermesManagedImageArtifactContext,
): string {
	const managedPackageDirectories =
		artifactContext.kind === 'local-artifact-context' ? '/opt/agent-vm/local-packages ' : '';
	const artifactInstallLines =
		artifactContext.kind === 'local-artifact-context'
			? renderHermesManagedImageLocalArtifactInstallLines(artifactContext)
			: renderHermesManagedImagePublicRegistryInstallLines(artifactContext);

	return [
		`FROM ${HERMES_AGENT_DISTRIBUTION.containerImage}`,
		'',
		'# Runtime credentials are supplied only at boot. This build uses public package indexes.',
		'ENV PNPM_HOME=/pnpm',
		'ENV PATH=${PNPM_HOME}:${PATH}',
		'',
		'RUN apt-get update && \\',
		'    apt-get install -y --no-install-recommends openssh-server ca-certificates git curl e2fsprogs && \\',
		'    rm -rf /var/lib/apt/lists/* && \\',
		'    update-ca-certificates && \\',
		`    npm install -g pnpm@${HERMES_GATEWAY_PNPM_VERSION} && \\`,
		'    pnpm --version && \\',
		'    python3 --version && \\',
		'    uv --version && \\',
		'    rm -rf /root/.cache/uv && \\',
		`    mkdir -p ${managedPackageDirectories}/home/hermes/.hermes /home/hermes/.cache /zone /run/sshd /root /work/tmp /work/cache /var/log && \\`,
		'    touch /var/log/lastlog /var/log/faillog && \\',
		'    (ln -sfn /proc/self/fd /dev/fd 2>/dev/null || true)',
		'',
		...artifactInstallLines,
		'',
		renderHermesTuiInstallCommand(),
		'',
		renderHermesShellEnvironmentInstallCommand(),
		'',
	].join('\n');
}

function buildHermesManagedImageBuildConfig(
	buildTarget: HermesManagedImageBuildTarget,
): HermesManagedImageBuildConfig {
	if (!Number.isSafeInteger(buildTarget.rootfsSizeMb) || buildTarget.rootfsSizeMb <= 0) {
		throw new Error('Hermes image rootfsSizeMb must be a positive integer.');
	}
	if (buildTarget.ociImage.trim().length === 0) {
		throw new Error('Hermes image ociImage must not be empty.');
	}
	return Object.freeze({
		arch: buildTarget.architecture,
		distro: 'alpine',
		alpine: Object.freeze({
			version: '3.23.0',
			kernelPackage: 'linux-virt',
			kernelImage: 'vmlinuz-virt',
			rootfsPackages: Object.freeze([]),
			initramfsPackages: Object.freeze([]),
		}),
		oci: Object.freeze({ image: buildTarget.ociImage, pullPolicy: 'never' }),
		rootfs: Object.freeze({ label: 'gondolin-root', sizeMb: buildTarget.rootfsSizeMb }),
	});
}

/** Renders the canonical deployment-owned Hermes custom image context files. */
export function renderHermesManagedImageRecipe(
	options: RenderHermesManagedImageRecipeOptions,
): HermesManagedImageRecipe {
	return Object.freeze({
		baseImage: HERMES_AGENT_DISTRIBUTION.containerImage,
		buildConfig: buildHermesManagedImageBuildConfig(options.buildTarget),
		buildNetworkAccess: Object.freeze({
			aptPackages: 'public-debian-repositories',
			containerImages: Object.freeze(HERMES_GATEWAY_CONTAINER_IMAGES),
			kind: 'upstream-hermes-image-with-public-package-indexes',
			npmPackages: 'public-npm-registry',
			pythonPackages: 'public-python-package-index',
			pythonRuntime: 'upstream-hermes-image',
		}),
		dockerfile: renderHermesManagedImageDockerfile(options.artifactContext),
		frameworkBootEntry: 'hermes-gateway',
		kind: 'hermes-managed-image-recipe',
		sourceRevision: HERMES_AGENT_DISTRIBUTION.sourceRevision,
	});
}
