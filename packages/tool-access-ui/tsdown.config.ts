import { defineConfig } from 'tsdown';
export default defineConfig({
	entry: ['src/index.ts', 'src/panel-fixture.ts'],
	format: 'esm',
	dts: true,
	clean: true,
	tsconfig: 'tsconfig.build.json',
	outDir: 'dist',
	outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
