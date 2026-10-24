import { defineConfig } from 'tsdown';
export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/contracts/index.ts', 'src/authorization/index.ts'],
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
