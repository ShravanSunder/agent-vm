import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/cli/tool-portal.ts',
		'src/adapter-boundary/index.ts',
		'src/approval-surface/index.ts',
		'src/artifact-surface/index.ts',
		'src/capability-description-surface/index.ts',
		'src/contracts/index.ts',
		'src/gateway-runtime-client/index.ts',
		'src/gateway-runtime-local-exec/index.ts',
		'src/gateway-runtime-local-exec/gateway-runtime-local-exec-helper.ts',
		'src/portal-call-surface/index.ts',
		'src/portal-event-surface/index.ts',
		'src/portable-contracts/index.ts',
		'src/testing/index.ts',
		'src/tool-portal-mcp-client/index.ts',
		'src/tool-portal-mcp-client/node-tool-portal-mcp-transport.ts',
	],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
