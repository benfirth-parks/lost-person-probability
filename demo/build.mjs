// Bundles the demo into a single self-contained HTML page (dist/demo.html).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const out = await build({ entryPoints: ['demo/main.ts'], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('demo/template.html', 'utf8').replace('/*__BUNDLE__*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/demo.html', html);
console.log(`dist/demo.html ${(html.length / 1024).toFixed(1)} KB`);
