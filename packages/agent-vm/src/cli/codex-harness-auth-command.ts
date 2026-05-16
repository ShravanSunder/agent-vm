import { execa } from 'execa';

import { agentIdSchema, type SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';
import { shellQuote, wrapWithOpenClawShellEnvironment } from './openclaw-shell-prefix.js';
import {
	resolveZoneAdminToken,
	zoneSshAccessResponseSchema,
	type ZoneSshAccessResponse,
} from './ssh-commands.js';

function buildCodexHarnessAuthRemoteCommand(agentId: string): string {
	const script = [
		'set -euo pipefail',
		`agent_id=${shellQuote(agentId)}`,
		'state_dir="${OPENCLAW_STATE_DIR:-/home/openclaw/.openclaw/state}"',
		'agent_dir="$state_dir/agents/$agent_id/agent"',
		'codex_home="$agent_dir/codex-home"',
		'auth_json="$codex_home/auth.json"',
		'mkdir -p "$agent_dir" "$codex_home"',
		'if ! chmod 700 "$agent_dir" "$codex_home"; then',
		'  echo "WARNING: could not chmod 700 $agent_dir and $codex_home; auth.json contains a refresh token." >&2',
		'fi',
		'codex_binary="$(command -v codex || true)"',
		'if [ -z "$codex_binary" ]; then',
		'  codex_js="$(find /pnpm/global/5/.pnpm /pnpm/global/5/node_modules /usr/local/lib/node_modules -path \'*/node_modules/@openai/codex/bin/codex.js\' -type f -print -quit 2>/dev/null || true)"',
		'  if [ -z "$codex_js" ]; then',
		'    echo "Could not locate the Codex CLI binary in PATH or pnpm global install paths." >&2',
		'    echo "Install @openai/codex in the OpenClaw gateway image, or add it to the gateway overlay extraOpenClawPackages before running auth codex-harness." >&2',
		'    exit 127',
		'  fi',
		'  codex_binary="node $codex_js"',
		'fi',
		'echo "Starting native Codex CLI login for agent: $agent_id"',
		'echo "CODEX_HOME=$codex_home"',
		'if [ "${codex_binary#node }" != "$codex_binary" ]; then',
		'  codex_js="${codex_binary#node }"',
		'  CODEX_HOME="$codex_home" node "$codex_js" login --device-auth',
		'else',
		'  CODEX_HOME="$codex_home" "$codex_binary" login --device-auth',
		'fi',
		'if [ ! -f "$auth_json" ]; then',
		'  echo "Codex login did not create auth.json at $auth_json." >&2',
		'  exit 1',
		'fi',
		'auth_mtime="$(stat -c "%y" "$auth_json" 2>/dev/null || true)"',
		'if [ -z "$auth_mtime" ]; then',
		'  auth_mtime="$(date -r "$auth_json" "+%Y-%m-%dT%H:%M:%S%z" 2>/dev/null || true)"',
		'fi',
		'if [ -z "$auth_mtime" ]; then',
		'  echo "WARNING: could not stat auth.json mtime at $auth_json." >&2',
		'  auth_mtime="unknown"',
		'fi',
		'profile_file="$agent_dir/auth-profiles.json"',
		'profile_count="unknown"',
		'if command -v node >/dev/null 2>&1; then',
		'  profile_count="$(node - "$profile_file" <<\'NODE\'',
		'const fs = require("node:fs");',
		'const profileFile = process.argv[2];',
		'try {',
		'  if (!fs.existsSync(profileFile)) {',
		'    console.log("0");',
		'    process.exit(0);',
		'  }',
		'  const parsed = JSON.parse(fs.readFileSync(profileFile, "utf8"));',
		'  const profiles = Object.values(parsed.profiles ?? {});',
		'  console.log(profiles.filter((profile) => profile && typeof profile === "object" && profile.provider === "openai-codex").length);',
		'} catch (error) {',
		'  console.error(`WARNING: Could not read OpenClaw auth profile count from ${profileFile}: ${error instanceof Error ? error.message : String(error)}`);',
		'  console.log("unknown");',
		'}',
		'NODE',
		'  )"',
		'else',
		'  echo "WARNING: node is unavailable; skipping OpenClaw auth profile count." >&2',
		'fi',
		'echo "Codex auth post-check:"',
		'echo "  auth.json: present"',
		'echo "  auth.json mtime: $auth_mtime"',
		'echo "  openai-codex profiles: $profile_count"',
		'legacy_main="$state_dir/agents/main/agent/auth-profiles.json"',
		'if [ -f "$legacy_main" ]; then',
		'  echo "WARNING: $legacy_main exists. If main is not an intentionally configured agent/global auth profile, it may shadow per-agent OpenClaw auth profiles." >&2',
		'fi',
		'if [ -d "$state_dir/agents" ]; then',
		'  if command -v node >/dev/null 2>&1; then',
		'    if ! node - "$auth_json" "$state_dir/agents" <<\'NODE\'',
		'const fs = require("node:fs");',
		'const path = require("node:path");',
		'const currentAuthPath = process.argv[2];',
		'const agentsDir = process.argv[3];',
		'function warning(message) {',
		'  console.error(`WARNING: ${message}`);',
		'}',
		'function readRefreshToken(authPath) {',
		'  try {',
		'    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));',
		'    return typeof parsed.refresh_token === "string" && parsed.refresh_token.trim() ? parsed.refresh_token : undefined;',
		'  } catch (error) {',
		'    warning(`could not read Codex auth token metadata from ${authPath}: ${error instanceof Error ? error.message : String(error)}`);',
		'    return undefined;',
		'  }',
		'}',
		'function findAuthFiles(rootDir) {',
		'  const matches = [];',
		'  const pending = [rootDir];',
		'  while (pending.length > 0) {',
		'    const currentDir = pending.pop();',
		'    if (!currentDir) {',
		'      continue;',
		'    }',
		'    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {',
		'      const entryPath = path.join(currentDir, entry.name);',
		'      if (entry.isDirectory()) {',
		'        pending.push(entryPath);',
		'        continue;',
		'      }',
		'      if (entry.isFile() && entryPath.split(path.sep).slice(-3).join("/") === "agent/codex-home/auth.json") {',
		'        matches.push(entryPath);',
		'      }',
		'    }',
		'  }',
		'  return matches;',
		'}',
		'let currentAuthBytes;',
		'try {',
		'  currentAuthBytes = fs.readFileSync(currentAuthPath);',
		'} catch (error) {',
		'  warning(`could not compare current Codex auth bytes from ${currentAuthPath}: ${error instanceof Error ? error.message : String(error)}`);',
		'  currentAuthBytes = undefined;',
		'}',
		'const currentRefreshToken = readRefreshToken(currentAuthPath);',
		'for (const otherAuthPath of findAuthFiles(agentsDir)) {',
		'  if (otherAuthPath === currentAuthPath) {',
		'    continue;',
		'  }',
		'  let byteIdentical = false;',
		'  try {',
		'    byteIdentical = Boolean(currentAuthBytes?.equals(fs.readFileSync(otherAuthPath)));',
		'  } catch (error) {',
		'    warning(`could not compare Codex auth bytes between ${currentAuthPath} and ${otherAuthPath}: ${error instanceof Error ? error.message : String(error)}`);',
		'    byteIdentical = false;',
		'  }',
		'  const otherRefreshToken = readRefreshToken(otherAuthPath);',
		'  if (currentRefreshToken && otherRefreshToken === currentRefreshToken) {',
		'    console.error(`WARNING: ${currentAuthPath} and ${otherAuthPath} share a Codex refresh token; shared refresh tokens rotate badly across agents.`);',
		'  } else if (byteIdentical) {',
		'    console.error(`WARNING: ${currentAuthPath} is byte-identical to ${otherAuthPath}; shared Codex refresh tokens rotate badly across agents.`);',
		'  }',
		'}',
		'NODE',
		'    then',
		'      echo "WARNING: shared-refresh-token diagnostic failed." >&2',
		'    fi',
		'  else',
		'    while IFS= read -r other_auth; do',
		'      if [ "$other_auth" != "$auth_json" ] && cmp -s "$auth_json" "$other_auth"; then',
		'        echo "WARNING: $auth_json is byte-identical to $other_auth; shared Codex refresh tokens rotate badly across agents." >&2',
		'      fi',
		'    done < <(find "$state_dir/agents" -path \'*/agent/codex-home/auth.json\' -type f 2>/dev/null)',
		'  fi',
		'fi',
	].join('\n');
	return wrapWithOpenClawShellEnvironment(script);
}

function buildSshArguments(
	sshResponse: ZoneSshAccessResponse,
	remoteCommand: string,
): readonly string[] {
	if (!sshResponse.host || !sshResponse.port) {
		throw new Error('Controller returned incomplete SSH access details.');
	}

	return [
		'-t',
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		remoteCommand,
	];
}

function resolveTargetAgentIds(options: {
	readonly agentId: string | undefined;
	readonly allAgents: boolean;
	readonly zone: SystemConfig['zones'][number];
}): readonly string[] {
	if (options.agentId && options.allAgents) {
		throw new Error('Use either --agent or --all-agents, not both.');
	}
	if (options.agentId) {
		return [agentIdSchema.parse(options.agentId)];
	}
	if (!options.allAgents) {
		throw new Error('auth codex-harness requires --agent <agentId> or --all-agents.');
	}

	const agentIds = (options.zone.agents ?? []).map((agent) => agent.id);
	if (agentIds.length === 0) {
		throw new Error(
			`Zone '${options.zone.id}' has no configured agents; use --agent <agentId> for a one-off login.`,
		);
	}
	return agentIds;
}

export async function runCodexHarnessAuthCommand(options: {
	readonly agentId?: string;
	readonly allAgents: boolean;
	readonly dependencies: Pick<
		CliDependencies,
		| 'createControllerClient'
		| 'createSecretResolver'
		| 'resolveServiceAccountToken'
		| 'runInteractiveProcess'
	>;
	readonly io: CliIo;
	readonly systemConfig: SystemConfig;
	readonly zone: SystemConfig['zones'][number];
}): Promise<void> {
	if (options.zone.gateway.type !== 'openclaw') {
		throw new Error(
			`auth codex-harness requires an OpenClaw zone, got '${options.zone.gateway.type}'.`,
		);
	}

	const agentIds = resolveTargetAgentIds({
		agentId: options.agentId,
		allAgents: options.allAgents,
		zone: options.zone,
	});
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const adminToken = await resolveZoneAdminToken({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zone: options.zone,
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(options.zone.id, {
			...(adminToken ? { adminToken } : {}),
			secretEnv: 'default',
		}),
	);
	if (!parsedSshResponse.success) {
		throw new Error(
			formatZodError('Controller returned an invalid SSH response:', parsedSshResponse.error),
			{ cause: parsedSshResponse.error },
		);
	}
	const sshResponse = parsedSshResponse.data;

	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, { stdio: 'inherit' });
		});

	for (const agentId of agentIds) {
		options.io.stdout.write(
			`Opening native Codex login for zone '${options.zone.id}' agent '${agentId}'.\n`,
		);
		try {
			// oxlint-disable-next-line no-await-in-loop -- device-auth flows are intentionally interactive and must run one agent at a time
			await runInteractiveProcess(
				'ssh',
				buildSshArguments(sshResponse, buildCodexHarnessAuthRemoteCommand(agentId)),
			);
		} catch (error) {
			throw new Error(
				`Codex login failed for zone '${options.zone.id}' agent '${agentId}': ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}
