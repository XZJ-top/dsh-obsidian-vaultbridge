import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createClient, publicError } from '../src/client.js';

const certPath = fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url));
const cert = await readFile(certPath, 'utf8');
const key = await readFile(new URL('./fixtures/key.pem', import.meta.url), 'utf8');
const apiKey = 'local-https-fixture-api-key';
const credentials = { get: () => ({ resolve: async () => ({ value: apiKey, source: 'test' }) }) };
async function secureMock(t) {
  const server = https.createServer({ key, cert }, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: cert, status: 'OK', authenticated: true, versions: {}, privateKey: key, apiKey }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `https://127.0.0.1:${server.address().port}`, apiKeyEnv: 'DSH_OBSIDIAN_TLS_TEST_KEY', timeoutMs: 2000 };
}

test('真实 HTTPS 默认校验证书；显式 CA 信任生效，无全局 TLS 修改', async t => {
  const config = await secureMock(t);
  const globalBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let error;
  try { await createClient(config, credentials).status(); } catch (value) { error = value; }
  assert.equal(error.code, 'TLS_ERROR');
  assert.ok(!JSON.stringify(publicError(error)).includes(apiKey));
  const trusted = await createClient({ ...config, caCertificatePath: certPath }, credentials).status();
  assert.equal(trusted.ok, true);
  assert.ok(!JSON.stringify(trusted).includes(cert));
  assert.ok(!JSON.stringify(trusted).includes(key));
  assert.ok(!JSON.stringify(trusted).includes(apiKey));
  const fallback = await createClient({ ...config, allowInsecureLocalTls: true }, credentials).status();
  assert.equal(fallback.server.authenticated, true);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, globalBefore);
});

test('data.json crypto.cert 自动 CA，crypto.caCert 优先，每操作读取且不会输出证书/私钥', async t => {
  const config = await secureMock(t);
  const folder = fileURLToPath(new URL(`./.tmp-tls-${process.pid}/`, import.meta.url));
  await mkdir(folder, { recursive: true });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const localRestConfigPath = `${folder}/data.json`;
  await writeFile(localRestConfigPath, JSON.stringify({ apiKey, crypto: { cert, privateKey: key, publicKey: 'ignored' } }));
  const client = createClient({ ...config, localRestConfigPath });
  assert.equal((await client.status()).ok, true);
  await writeFile(localRestConfigPath, JSON.stringify({ apiKey, crypto: { caCert: cert, cert: 'invalid-but-not-used', privateKey: key } }));
  assert.equal((await client.status()).ok, true);
  await writeFile(localRestConfigPath, JSON.stringify({ apiKey, crypto: { cert: 'invalid-cert' } }));
  await assert.rejects(client.status(), { code: 'INVALID_CA' });
  await writeFile(localRestConfigPath, `invalid-json ${apiKey}`);
  let error;
  try { await client.status(); } catch (value) { error = value; }
  assert.equal(error.code, 'INVALID_LOCAL_CONFIG');
  assert.ok(!JSON.stringify(publicError(error)).includes(apiKey));
});
