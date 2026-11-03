import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createPrototypeConfig, writeSingleHtml } from './bundle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
await build(await createPrototypeConfig({ root, outDir }));
console.log(`已生成：${path.join(outDir, writeSingleHtml(outDir))}`);
