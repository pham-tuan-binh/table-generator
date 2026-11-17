// Command-line generator: params JSON in, the same file tree the web app downloads out.
//   npm run generate -- [params.json] [out-dir]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalize } from '../src/params.ts';
import { buildModel } from '../src/model.ts';
import { bundle } from '../src/export/bundle.ts';
import { checks } from '../src/bom.ts';

const [inFile, outDir = 'out'] = process.argv.slice(2);
const params = normalize(inFile ? JSON.parse(readFileSync(inFile, 'utf8')) : {});
const model = buildModel(params);
const files = bundle(model);
for (const [path, data] of Object.entries(files)) {
  const full = join(outDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof data === 'string' ? data : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer));
}
console.log(`${Object.keys(files).length} files in ${outDir}/ · ${model.parts.length} parts · ${model.mass.toFixed(1)} kg`);
for (const c of checks(model)) if (!c.ok) console.log(`${c.level}: ${c.text}`);
