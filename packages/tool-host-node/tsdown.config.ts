import { defineConfig } from 'tsdown';
export default defineConfig({
	clean: true,
	dts: true,
	entry: {
		index: 'src/index.ts',
		'catalog-typescript/index': 'src/catalog-typescript/index.ts',
		'bin/tool-host-node': 'src/bin/tool-host-node.ts',
	},
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
