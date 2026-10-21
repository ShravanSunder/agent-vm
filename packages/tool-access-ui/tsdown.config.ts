import { defineConfig } from 'tsdown';
export default defineConfig({
	entry: { index: 'src/index.ts', 'panel-fixture': 'src/panel-demo/panel-fixture.ts' },
	format: 'esm',
	dts: true,
	clean: true,
	tsconfig: 'tsconfig.build.json',
	outDir: 'dist',
	outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
