import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/sign-in-core/index.ts', 'src/cloudflare-host/index.ts'],
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
	external: ['cloudflare:workers'],
});
