import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Reproducible, local-only asset generation from exact npm package versions.
const root = process.cwd();
const output = path.join(root, 'public/fonts/design-v1');
await mkdir(output, { recursive: true });
const faces: Record<string, Array<{ file: string; sha256: string }>> = {};
let css = '';
for (const [slug, family] of [['lora', 'Lora'], ['source-sans-3', 'Source Sans 3'], ['nunito', 'Nunito']]) {
  const source = path.join(root, 'node_modules/@fontsource', slug);
  await copyFile(path.join(source, 'LICENSE'), path.join(output, `${slug}-LICENSE.txt`));
  for (const weight of [400, 700]) for (const style of ['normal', 'italic']) {
    const id = `${slug}-${weight}-${style}`;
    faces[id] = [];
    for (const subset of ['latin', 'latin-ext']) {
      const bytes = await readFile(path.join(source, 'files', `${slug}-${subset}-${weight}-${style}.woff`));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const file = `/fonts/design-v1/${id}-${subset}-${sha256.slice(0, 16)}.woff`;
      await writeFile(path.join(root, 'public', file), bytes);
      faces[id].push({ file, sha256 });
      css += `@font-face{font-family:'${family}';font-weight:${weight};font-style:${style};font-display:block;src:url('${file}') format('woff');unicode-range:${subset === 'latin' ? 'U+0000-00FF,U+2000-206F,U+20AC' : 'U+0100-017F'};}\n`;
    }
  }
}
await writeFile(path.join(root, 'src/lib/editor/design-font-manifest.json'), JSON.stringify(faces, null, 2) + '\n');
await writeFile(path.join(output, 'fonts.css'), css);
console.log(`Bundled ${Object.keys(faces).length} font faces with licenses and integrity hashes.`);
