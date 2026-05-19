import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/core/index.ts',
		'src/mcp-proxy/index.ts',
		'src/cli/index.ts',
		'src/portal-config/index.ts',
		'src/bin/mcp-portal.ts',
		'src/testing/fake-upstream-mcp-server.ts',
	],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
