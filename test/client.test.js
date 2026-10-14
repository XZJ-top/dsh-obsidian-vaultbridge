import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient, hash, renderPaperNote, normalizeConfig, validatePath, publicError } from '../src/client.js';
import { apply, Config, inject, name } from '../src/index.js';

const KEY = 'mock-secret-never-disclosed';
const envName = 'DSH_OBSIDIAN_UNIT_TEST_KEY';
async function mock(t, options = {}) {
  const files = new Map([['existing.md', 'old content'], ['中文/笔记.md', '# 中文笔记\n'], ['DSH/paper.md', 'existing paper']]);
  const calls = [];
  let daily = '# Today\n';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({ method: req.method, url, body, headers: req.headers });
    if (options.handle?.(req, res, url, body)) return;
    if (url.pathname === '/hang') return;
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/') return json({ status: 'OK', service: 'Obsidian Local REST API', authenticated: true, versions: { self: 'test', obsidian: 'test' }, apiKey: KEY, crypto: { cert: 'must-not-return' } });
    if (url.pathname === '/search/simple/') return json([{ filename: 'existing.md', matches: [{ context: `match ${KEY}`, match: { start: 0, end: 3 } }] }, { filename: '.obsidian/data.json', matches: [] }]);
    if (url.pathname === '/periodic/daily/') {
      if (req.method === 'POST') { daily += body; res.statusCode = 204; return res.end(); }
      return res.end(daily);
    }
    if (url.pathname.startsWith('/open/')) { res.statusCode = 204; return res.end(); }
    if (url.pathname === '/vault/' || url.pathname === '/vault/folder/') return json({ files: ['existing.md', '中文/', '.obsidian/'] });
    if (url.pathname.startsWith('/vault/')) {
      const path = url.pathname.slice('/vault/'.length).split('/').map(decodeURIComponent).join('/');
      if (path === 'hang.md') return;
      if (req.method === 'GET') {
        if (!files.has(path)) { res.statusCode = 404; return json({ message: `secret ${KEY}` }); }
        res.setHeader('Content-Type', 'text/markdown');
        return res.end(files.get(path));
      }
      if (req.method === 'PUT') files.set(path, body);
      if (req.method === 'POST') {
        const current = files.get(path);
        files.set(path, current === undefined ? body : `${current}${current.endsWith('\n') ? '' : '\n'}${body}`);
      }
      res.statusCode = 204; return res.end();
    }
    res.statusCode = 404; json({ message: KEY });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: envName, timeoutMs: 2000 };
  const context = { get: service => service === 'credentials' ? { resolve: async () => ({ value: KEY, source: 'test' }) } : undefined };
  return { client: createClient({ ...config, ...options.config }, options.context || context), files, calls, config, context };
}

test('真实 HTTP：状态投影、目录 endpoint、Markdown Accept 和中文分段编码', async t => {
  const { client, calls } = await mock(t);
  const status = await client.status();
  assert.equal(status.server.authenticated, true);
  assert.ok(!JSON.stringify(status).includes(KEY));
  assert.ok(!JSON.stringify(status).includes('must-not-return'));
  assert.deepEqual((await client.list()).files, ['existing.md', '中文/']);
  await client.list({ path: 'folder' });
  const note = await client.read({ path: '中文/笔记.md' });
  assert.equal(note.content, '# 中文笔记\n');
  assert.equal(note.sha256, hash(note.content));
  assert.equal(note.trust, 'external-untrusted');
  assert.equal(calls.at(-1).url.pathname, '/vault/%E4%B8%AD%E6%96%87/%E7%AC%94%E8%AE%B0.md');
  assert.equal(calls.at(-1).headers.accept, 'text/markdown');
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[2].url.pathname, '/vault/folder/');
});

test('search/simple 按官方契约 POST + query 参数，无 JSON body，并保护凭据', async t => {
  const { client, calls } = await mock(t);
  const result = await client.search({ query: '中文 "query" & /', contextLength: 42 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/search/simple/');
  assert.equal(calls[0].url.searchParams.get('query'), '中文 "query" & /');
  assert.equal(calls[0].url.searchParams.get('contextLength'), '42');
  assert.equal(calls[0].body, '');
  assert.equal(result.results.length, 1);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.match(result.results[0].matches[0].context, /REDACTED/);
  await assert.rejects(client.search({ query: '', contextLength: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('默认 create 已存在时拒绝且没有 PUT；新路径先读取再 PUT', async t => {
  const { client, files, calls } = await mock(t);
  await assert.rejects(client.write({ path: 'existing.md', content: 'bad overwrite' }), { code: 'CREATE_CONFLICT' });
  assert.equal(calls.length, 1);
  assert.equal(files.get('existing.md'), 'old content');
  const result = await client.write({ path: '新建/笔记.md', content: '# 新笔记\n' });
  assert.equal(result.mode, 'create');
  assert.equal(result.sha256, hash('# 新笔记\n'));
  assert.equal(calls.at(-2).method, 'PUT');
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-2).headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(files.get('新建/笔记.md'), '# 新笔记\n');
});

test('replace 要求 hash，冲突不写入，匹配 hash 才 PUT', async t => {
  const { client, files, calls } = await mock(t);
  await assert.rejects(client.write({ path: 'existing.md', content: 'new', mode: 'replace' }), { code: 'EXPECTED_HASH_REQUIRED' });
  assert.equal(calls.length, 0);
  await assert.rejects(client.write({ path: 'existing.md', content: 'new', mode: 'replace', expectedSha256: hash('stale') }), { code: 'HASH_CONFLICT' });
  assert.equal(files.get('existing.md'), 'old content');
  assert.equal(calls.length, 1);
  const read = await client.read({ path: 'existing.md' });
  await client.write({ path: 'existing.md', content: 'new', mode: 'replace', expectedSha256: read.sha256 });
  assert.equal(files.get('existing.md'), 'new');
  assert.equal(calls.at(-2).method, 'PUT');
  assert.equal(calls.at(-1).method, 'GET');
});

test('append、daily read/append 与 open 精确 endpoints', async t => {
  const { client, files, calls } = await mock(t);
  const appended = await client.write({ path: 'existing.md', content: 'extra', mode: 'append' });
  assert.equal(appended.appendedSha256, hash('extra'));
  assert.equal(appended.verified, true);
  assert.equal(files.get('existing.md'), 'old content\nextra');
  assert.equal(calls[1].method, 'POST');
  const daily = await client.daily();
  assert.equal(daily.content, '# Today\n');
  assert.equal(calls.at(-1).url.pathname, '/periodic/daily/');
  await client.daily({ mode: 'append', content: '- done\n' });
  assert.equal(calls.at(-2).method, 'POST');
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal((await client.daily()).content, '# Today\n- done\n');
  await client.open({ path: '中文/笔记.md' });
  assert.equal(calls.at(-1).url.pathname, '/open/%E4%B8%AD%E6%96%87/%E7%AC%94%E8%AE%B0.md');
  assert.equal(calls.at(-1).method, 'POST');
});

test('凭据每操作解析，凭据服务优先，其次环境变量，再 data.json', async t => {
  let current = 'rotating-A';
  let resolved = 0;
  const ctx = { get: name => name === 'credentials' ? { resolve: async ref => { assert.equal(ref, envName); resolved++; return { value: current, source: 'test' }; } } : undefined };
  const { client, config, calls } = await mock(t, { context: ctx });
  await client.status(); current = 'rotating-B'; await client.status();
  assert.equal(resolved, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer rotating-A');
  assert.equal(calls[1].headers.authorization, 'Bearer rotating-B');
  const folder = fileURLToPath(new URL(`./.tmp-credentials-${process.pid}/`, import.meta.url));
  await mkdir(folder, { recursive: true });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = `${folder}/data.json`;
  await writeFile(settingsPath, JSON.stringify({ apiKey: 'file-key' }));
  const old = process.env[envName];
  t.after(() => { if (old === undefined) delete process.env[envName]; else process.env[envName] = old; });
  process.env[envName] = 'env-key';
  const fallback = createClient({ ...config, localRestConfigPath: settingsPath }, { get: () => undefined });
  await fallback.status(); assert.equal(calls.at(-1).headers.authorization, 'Bearer env-key');
  delete process.env[envName];
  await fallback.status(); assert.equal(calls.at(-1).headers.authorization, 'Bearer file-key');
  await writeFile(settingsPath, JSON.stringify({ apiKey: 'updated-file-key' }));
  await fallback.status(); assert.equal(calls.at(-1).headers.authorization, 'Bearer updated-file-key');
  await assert.rejects(createClient(config).status(), { code: 'MISSING_CREDENTIAL' });
});

test('路径穿越及敏感目录在网络请求前拒绝，百分号编码不能绕过', async t => {
  const { client, calls } = await mock(t);
  const rejected = ['/absolute.md', 'C:/vault/a.md', 'a\\b.md', '../secret', 'a/../secret', 'a//b', 'a/', './a', '.obsidian/data.json', 'a/.Obsidian/b', 'a?b', 'a#b', 'a\u0000b', '%2e%2e/secret', 'a./b', 'a /b', 'file:stream'];
  for (const path of rejected) {
    assert.throws(() => validatePath(path), { code: 'INVALID_PATH' });
    await assert.rejects(client.read({ path }), { code: 'INVALID_PATH' });
    await assert.rejects(client.write({ path, content: 'x' }), { code: 'INVALID_PATH' });
    await assert.rejects(client.open({ path }), { code: 'INVALID_PATH' });
  }
  assert.equal(calls.length, 0);
});

test('baseUrl 禁止凭据/query/hash/路径、外部 HTTP，不安全 TLS 只限 HTTPS 127.0.0.1', () => {
  for (const baseUrl of ['https://user:pass@127.0.0.1:27124', 'http://example.com', 'https://example.com/?a=b', 'https://example.com/#x', 'https://example.com/extra', 'ftp://127.0.0.1', 'https://127.0.0.1?', 'https://127.0.0.1#', 'https://127.0.0.1\\evil']) {
    assert.throws(() => normalizeConfig({ baseUrl }), { code: 'INVALID_CONFIG' });
  }
  assert.equal(normalizeConfig().allowInsecureLocalTls, false);
  assert.equal(normalizeConfig({ baseUrl: 'http://[::1]:123' }).baseUrl, 'http://[::1]:123');
  assert.throws(() => normalizeConfig({ baseUrl: 'https://example.com', allowInsecureLocalTls: true }), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeConfig({ baseUrl: 'https://localhost:27124', allowInsecureLocalTls: true }), { code: 'INVALID_CONFIG' });
  assert.equal(normalizeConfig({ allowInsecureLocalTls: true }).allowInsecureLocalTls, true);
});

test('超时、中途取消及预先取消', async t => {
  const { client, calls } = await mock(t, { config: { timeoutMs: 60 } });
  await assert.rejects(client.read({ path: 'hang.md' }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = client.read({ path: 'hang.md' }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error(`untrusted reason ${KEY}`)), 15);
  await assert.rejects(pending, { code: 'ABORTED' });
  const count = calls.length;
  await assert.rejects(client.status({}, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(calls.length, count);
});

test('大小上限：带 Content-Length、chunked response 和请求正文', async t => {
  const { client, calls } = await mock(t, {
    config: { maxResponseBytes: 10 },
    handle(req, res, url) {
      if (url.pathname === '/vault/declared.md') { res.setHeader('Content-Length', '100'); res.end('x'.repeat(100)); return true; }
      if (url.pathname === '/vault/chunked.md') { res.write('x'.repeat(8)); res.end('x'.repeat(8)); return true; }
    },
  });
  await assert.rejects(client.read({ path: 'declared.md' }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(client.read({ path: 'chunked.md' }), { code: 'RESPONSE_TOO_LARGE' });
  const count = calls.length;
  await assert.rejects(client.write({ path: 'new.md', content: '中文中文中文中文' }), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(calls.length, count);
});

test('HTTP 错误、重定向与无效 JSON 不回显 auth/body 且不跟随', async t => {
  const { client, calls } = await mock(t, {
    handle(req, res, url) {
      if (url.pathname === '/vault/auth.md') { res.statusCode = 401; res.end(`${KEY} Bearer auth-body`); return true; }
      if (url.pathname === '/vault/redirect.md') { res.statusCode = 302; res.setHeader('Location', 'http://example.com/'); res.end(KEY); return true; }
      if (url.pathname === '/search/simple/') { res.end(`bad json ${KEY}`); return true; }
    },
  });
  for (const path of ['auth.md', 'redirect.md']) {
    let caught;
    try { await client.read({ path }); } catch (error) { caught = error; }
    assert.equal(caught.code, 'HTTP_ERROR');
    assert.ok(!JSON.stringify(publicError(caught)).includes(KEY));
    assert.ok(!JSON.stringify(publicError(caught)).includes('auth-body'));
  }
  await assert.rejects(client.search({ query: 'q' }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(publicError(new Error(`secret ${KEY}`))).includes(KEY));
});

test('论文笔记 YAML 使用 JSON quoted scalar/array，source 与 AI summary 分开', async t => {
  const args = { title: 'Title: "quoted"\n---', authors: ['A: author', 'B\nC'], doi: '10.test/:abc', url: 'https://example.com', abstract: 'SOURCE ONLY', summary: 'AI ONLY', zoteroItemKey: 'ABC123', tags: ['x:y', 'yes'] };
  const rendered = renderPaperNote(args);
  assert.ok(rendered.includes(`title: ${JSON.stringify(args.title)}`));
  assert.ok(rendered.includes(`authors: ${JSON.stringify(args.authors)}`));
  assert.ok(rendered.includes('## 来源摘要（Source abstract）\n\nSOURCE ONLY'));
  assert.ok(rendered.includes('## AI 总结（AI summary，待核实）\n\nAI ONLY'));
  const { client, files } = await mock(t);
  const result = await client.paperNote(args);
  assert.match(result.path, /^DSH\//);
  assert.equal(files.get(result.path), rendered);
  await assert.rejects(client.paperNote({ ...args, path: 'DSH/paper.md' }), { code: 'CREATE_CONFLICT' });
  await assert.rejects(client.paperNote({ ...args, path: '../paper.md' }), { code: 'INVALID_PATH' });
});

test('Schema import 可用、默认配置 GUI 字段齐全、effect disposer、JSON execute/render 与并发分类', async t => {
  assert.equal(name, 'dsh-obsidian-vaultbridge');
  assert.deepEqual(inject, ['tools']);
  const config = Config({});
  for (const field of ['baseUrl', 'apiKeyEnv', 'localRestConfigPath', 'caCertificatePath', 'allowInsecureLocalTls', 'timeoutMs', 'maxResponseBytes', 'defaultFolder', 'vaultName']) assert.ok(Object.hasOwn(config, field));
  const { config: mockConfig, context } = await mock(t);
  const definitions = new Map();
  const disposers = [];
  const ctx = { ...context, tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } }, effect(callback) { disposers.push(callback()); } };
  apply(ctx, mockConfig);
  assert.equal(definitions.size, 8);
  for (const [name, definition] of definitions) {
    assert.equal(definition.isConcurrencySafe({}), ['obsidian_status', 'obsidian_list', 'obsidian_read', 'obsidian_search'].includes(name));
    assert.ok(definition.output.schema);
    assert.deepEqual(definition.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }]);
  }
  const result = await definitions.get('obsidian_status').execute({}, { signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.ok(!Object.hasOwn(result, 'content'));
  const error = await definitions.get('obsidian_write').execute({ path: 'existing.md', content: 'bad' }, {});
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'CREATE_CONFLICT');
  for (const dispose of disposers) dispose();
  assert.equal(definitions.size, 0);
});

test('写后读回精确核验：服务篡改结果时提示已提交，不自动重写', async t => {
  let stored;
  let puts = 0;
  const { client } = await mock(t, {
    handle(req, res, url, body) {
      if (url.pathname !== '/vault/verify.md') return false;
      if (req.method === 'GET') {
        if (stored === undefined) { res.statusCode = 404; res.end(); }
        else res.end(stored);
      } else if (req.method === 'PUT') { puts++; stored = `${body} changed externally`; res.statusCode = 204; res.end(); }
      return true;
    },
  });
  await assert.rejects(client.write({ path: 'verify.md', content: 'expected' }), { code: 'WRITE_VERIFICATION_FAILED' });
  assert.equal(puts, 1);
});

test('凭据服务慢于 deadline 时仍超时，无迟到的网络请求', async t => {
  let finish;
  const { client, calls } = await mock(t, {
    config: { timeoutMs: 30 },
    context: { get: () => ({ resolve: () => new Promise(resolve => { finish = resolve; }) }) },
  });
  await assert.rejects(client.status(), { code: 'TIMEOUT' });
  finish({ value: KEY, source: 'test' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('同客户端并发 create 串行，避免内部检查与写入竞争', async t => {
  const { client, files } = await mock(t);
  const results = await Promise.allSettled([client.write({ path: 'once.md', content: 'first' }), client.write({ path: 'once.md', content: 'second' })]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'CREATE_CONFLICT');
  assert.equal(files.get('once.md'), 'first');
});
