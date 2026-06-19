import { describe, expect, it } from 'vitest';

import {
	formatOpenClawRuntimeImageInspection,
	parseInspectOpenClawRuntimeImageArgs,
	parseOpenClawRuntimeImageInspection,
} from './inspect-openclaw-runtime-image.ts';
import { stripJsonComments } from './jsonc-comments.ts';

describe('OpenClaw runtime image inspection script', () => {
	it('resolves image tag input from a build config path', () => {
		expect(
			parseInspectOpenClawRuntimeImageArgs([
				'--build-config',
				'../shravan-claw-beta/vm-images/gateways/openclaw/build-config.jsonc',
			]),
		).toEqual({
			buildConfigPath: '../shravan-claw-beta/vm-images/gateways/openclaw/build-config.jsonc',
		});
	});

	it('strips JSONC comments without corrupting URL or comment-like string values', () => {
		const parsedConfig = JSON.parse(
			stripJsonComments(`{
				// leading comment
				"oci": {
					"image": "registry.example/openclaw:latest", // trailing comment
					"url": "https://example.test/a//b",
					"lineLiteral": "//not-a-comment",
					"blockLiteral": "/*not-a-comment*/",
					"escapedQuote": "value with \\" quote"
				},
				/* block comment */
				"ok": true
			}`),
		);

		expect(parsedConfig).toMatchObject({
			oci: {
				blockLiteral: '/*not-a-comment*/',
				escapedQuote: 'value with " quote',
				image: 'registry.example/openclaw:latest',
				lineLiteral: '//not-a-comment',
				url: 'https://example.test/a//b',
			},
			ok: true,
		});
	});

	it('formats stable package-resolution proof lines', () => {
		expect(
			formatOpenClawRuntimeImageInspection({
				image: 'agent-vm-openclaw:beta',
				packages: [
					{
						name: 'openclaw',
						version: '2026.6.8',
						undici: [
							{
								path: 'node_modules/undici/package.json',
								resolvedFrom: 'openclaw',
								version: '8.5.0',
							},
						],
					},
					{
						name: '@openclaw/discord',
						version: '2026.6.8',
						undici: [
							{
								path: 'node_modules/undici/package.json',
								resolvedFrom: '@openclaw/discord',
								version: '8.5.0',
							},
						],
					},
					{
						name: '@openclaw/codex',
						version: '2026.6.8',
						undici: [],
					},
				],
			}),
		).toBe(
			[
				'OpenClaw runtime image inspection: image=agent-vm-openclaw:beta',
				'  openclaw@2026.6.8 -> undici@8.5.0 resolvedFrom=openclaw path=node_modules/undici/package.json',
				'  @openclaw/discord@2026.6.8 -> undici@8.5.0 resolvedFrom=@openclaw/discord path=node_modules/undici/package.json',
				'  @openclaw/codex@2026.6.8 -> undici=not-resolved',
				'',
			].join('\n'),
		);
	});

	it('rejects vulnerable nested undici copies under inspected packages', () => {
		expect(() =>
			parseOpenClawRuntimeImageInspection(
				JSON.stringify({
					image: 'agent-vm-openclaw:beta',
					packages: [
						{
							name: '@openclaw/codex',
							version: '2026.6.8',
							undici: [
								{
									path: 'node_modules/@openclaw/internal/node_modules/undici/package.json',
									resolvedFrom: '@openclaw/codex',
									version: '8.3.0',
								},
							],
						},
					],
				}),
			),
		).toThrow(/Unexpected @openclaw\/codex undici@8\.3\.0/u);
	});
});
