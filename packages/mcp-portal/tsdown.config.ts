import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/tool-vm/index.ts',
		'src/bin/agent-vm-mcp-portal.ts',
		'src/bin/portal-server.ts',
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
