import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function createPrototypeConfig({ root, outDir, dependencyRoot = root, jszipPath }) {
  const require = createRequire(path.join(dependencyRoot, 'package.json'));
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const aliases = ['core', 'event', 'window'].map(name => ({ find: `@tauri-apps/api/${name}`, replacement: path.join(root, 'prototype', `${name}.ts`) }));
  if (jszipPath) aliases.push({ find: 'jszip', replacement: jszipPath });
  for (const name of Object.keys(packageJson.dependencies).filter(name => name !== 'jszip')) {
    const directory = path.join(dependencyRoot, 'node_modules', name);
    if (fs.existsSync(directory)) aliases.push({ find: name, replacement: fs.realpathSync(directory) });
  }
  return {
    configFile: false, root, base: './',
    resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
    plugins: [{ name: 'prototype-inline-workers', enforce: 'pre', transform(source, id) {
      if (id.includes('node_modules') || !/\.[jt]sx?$/.test(id)) return;
      const imports = [];
      const code = source.replace(/new Worker\(new URL\((['"])([^'"]+)\1, import\.meta\.url\), \{ type: ['"]module['"] \}\)/g, (_match, _quote, file) => {
        const name = `PrototypeInlineWorker${imports.length}`; imports.push(`import ${name} from ${JSON.stringify(`${file}?worker&inline`)};`); return `new ${name}()`;
      });
      if (imports.length) return { code: `${imports.join('\n')}\n${code}`, map: null };
    } }, react()],
    build: { outDir, emptyOutDir: true, assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false, modulePreload: false, sourcemap: false, rollupOptions: { output: { inlineDynamicImports: true } } },
  };
}

export function writeSingleHtml(outDir, fileName = '工作台-v1.2.5-HTML原型.html') {
  const index = path.join(outDir, 'index.html');
  let html = fs.readFileSync(index, 'utf8');
  html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g, (_match, file) => {
    const code = fs.readFileSync(path.join(outDir, file), 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script type="module">${code}</script>`;
  });
  html = html.replace(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g, (_match, file) => `<style>${fs.readFileSync(path.join(outDir, file), 'utf8').replace(/<\/style/gi, '<\\/style')}</style>`);
  if (/<(?:script|link)\b[^>]*(?:src|href)="\.\//.test(html)) throw new Error('仍然存在未内嵌的脚本或样式');
  fs.writeFileSync(path.join(outDir, fileName), html);
  return fileName;
}
