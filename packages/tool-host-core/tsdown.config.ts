import { defineConfig } from 'tsdown';
export default defineConfig({
	clean: true,
	dts: true,
	entry: { index: 'src/index.ts' },
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
