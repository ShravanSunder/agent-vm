import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	resolve: { alias: { '@tool-access-ui': fileURLToPath(new URL('./src', import.meta.url)) } },
	build: { outDir: 'dist/demo', emptyOutDir: false },
	server: { host: '127.0.0.1' },
});
