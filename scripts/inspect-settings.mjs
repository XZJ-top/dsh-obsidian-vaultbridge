// Read-only structural inspection: never print values, key material or certificates.
import { readFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('Provide the Local REST API data.json path.');
try {
  const data = JSON.parse(await readFile(path, 'utf8'));
  const shape = (value, depth = 0) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value !== 'object' || depth >= 3) return typeof value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child, depth + 1)]));
  };
  console.log(JSON.stringify(shape(data), null, 2));
} catch {
  console.error('Unable to inspect settings structure; no file contents disclosed.');
  process.exitCode = 1;
}
