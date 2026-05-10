import type { OpenClawToolRegistrationApi } from './openclaw-sandbox-sdk-contract.js';

export interface RegisterZoneGitToolOptions {
	readonly api: OpenClawToolRegistrationApi;
	readonly controllerUrl: string;
	readonly fetchImpl?: typeof fetch;
	readonly zoneGitToken?: string;
	readonly zoneId: string;
}

const zoneGitCapabilityHeader = 'x-agent-vm-zone-git-token';

function readExpectedHead(input: unknown): string {
	if (typeof input !== 'object' || input === null || !('expectedHead' in input)) {
		throw new Error('zone_git_push requires expectedHead.');
	}
	const expectedHead = input.expectedHead;
	if (typeof expectedHead !== 'string' || expectedHead.length === 0) {
		throw new Error('zone_git_push requires expectedHead.');
	}
	return expectedHead;
}

function buildControllerUrl(controllerUrl: string, zoneId: string): string {
	return `${controllerUrl.replace(/\/$/u, '')}/zones/${encodeURIComponent(zoneId)}/zone-git/push`;
}

async function readResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function parseJsonPayload(responseText: string): unknown {
	try {
		return JSON.parse(responseText);
	} catch (error) {
		throw new Error(`zone_git_push returned non-JSON response: ${responseText.slice(0, 500)}`, {
			cause: error,
		});
	}
}

export function registerZoneGitTool(options: RegisterZoneGitToolOptions): void {
	if (!options.api.registerTool) {
		return;
	}
	options.api.registerTool(
		{
			name: 'zone_git_push',
			description:
				'Push committed OpenClaw zone workspace changes through the agent-vm controller. Use after git commit; do not run raw git push.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					expectedHead: { type: 'string' },
				},
				required: ['expectedHead'],
			},
			execute: async (_toolCallId: string, input: unknown) => {
				const expectedHead = readExpectedHead(input);
				const response = await (options.fetchImpl ?? fetch)(
					buildControllerUrl(options.controllerUrl, options.zoneId),
					{
						body: JSON.stringify({ expectedHead }),
						headers: {
							'content-type': 'application/json',
							...(options.zoneGitToken ? { [zoneGitCapabilityHeader]: options.zoneGitToken } : {}),
						},
						method: 'POST',
					},
				);
				const responseText = await readResponseText(response);
				if (!response.ok) {
					throw new Error(`zone_git_push failed: ${response.status} ${responseText.slice(0, 500)}`);
				}
				const payload = parseJsonPayload(responseText);
				return {
					content: JSON.stringify(payload),
					details: payload,
				};
			},
		},
		{ name: 'zone_git_push', optional: true },
	);
}
