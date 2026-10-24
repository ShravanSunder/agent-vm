import { defineConfig } from 'tsdown';
export default defineConfig({
	clean: true,
	deps: { neverBundle: ['hono', '@hono/node-server'] },
	dts: true,
	entry: {
		index: 'src/index.ts',
		'catalog-typescript/index': 'src/catalog-typescript/index.ts',
		'bin/tool-host-node': 'src/bin/tool-host-node.ts',
		'testing/fake-upstream-mcp-server': 'src/testing/fake-upstream-mcp-server.ts',
	},
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
