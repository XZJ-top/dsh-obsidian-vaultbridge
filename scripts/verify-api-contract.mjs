// Verify only selected upstream public contract sections; no code is copied.
const url = 'https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/532af35659251a008a1b01f0f89aaa73205ce58d/docs/openapi.yaml';
const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error('Upstream specification unavailable.');
const text = await response.text();
for (const endpoint of ['/search/simple/', '/periodic/{period}/', '/open/{filename}', '/vault/{filename}']) {
  const start = text.indexOf(`  ${endpoint}:\n`);
  if (start < 0) { console.log(`${endpoint}: no exact match`); continue; }
  const next = text.slice(start + 1).search(/^  \/[^\n]+:\s*$/m);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  console.log(section.slice(0, endpoint === '/search/simple/' ? 7000 : 2500));
}
console.log('Related endpoint names:', text.match(/^  \/(?:open|periodic|vault)[^\n]*:/gm));
