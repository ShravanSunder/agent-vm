import { build } from 'esbuild';
await build({
	entryPoints: ['src/review-application.tsx'],
	bundle: true,
	outfile: 'public/app.js',
	jsx: 'automatic',
	minify: true,
	define: { 'process.env.NODE_ENV': '"production"' },
	sourcemap: true,
});
