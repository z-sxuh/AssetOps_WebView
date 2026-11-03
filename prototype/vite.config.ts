import { fileURLToPath } from 'node:url';
import { createPrototypeConfig } from './prototype/bundle.mjs';
export default await createPrototypeConfig({ root: fileURLToPath(new URL('.', import.meta.url)), outDir: 'dist' });
