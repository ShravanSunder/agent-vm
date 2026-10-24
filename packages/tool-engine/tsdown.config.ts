import { defineConfig } from 'tsdown';
export default defineConfig({
	clean: true,
	dts: true,
	entry: {
		'standalone-tool-portal/index': 'src/standalone-tool-portal/index.ts',
		'capability-dispatch/index': 'src/capability-dispatch/index.ts',
		'mcp-gateway/index': 'src/mcp-gateway/index.ts',
		'upstream-mcp-connectors/index': 'src/upstream-mcp-connectors/index.ts',
	},
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
