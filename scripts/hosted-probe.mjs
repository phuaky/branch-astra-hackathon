import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../dist/server/index.js';

const origin = 'https://branch-astra-soil-rose.kuan-builds.chatgpt.site';
const checks = [];
const key = 'hosted-test-only-noncredential';
const env = { OPENAI_API_KEY: key };
const request = (path, options) => new Request(`${origin}${path}`, options);

const status = await worker.fetch(request('/api/status'), env);
assert.equal(status.status, 200);
assert.equal((await status.clone().json()).configured, true);
assert.equal(status.headers.get('cache-control'), 'no-store');
assert.ok(!(await status.text()).includes(key));
checks.push('hosted status reads its runtime key without returning it');
assert.equal((await (await worker.fetch(request('/api/status'), {})).json()).configured, false);
checks.push('missing hosted key does not use a local or ambient credential');

const page = await worker.fetch(request('/'), env);
assert.equal(page.status, 200);
const html = await page.text();
for (const path of [...html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map(match => match[1])) {
  const asset = await worker.fetch(request(path), env);
  assert.equal(asset.status, 200, path);
  assert.ok(!(await asset.text()).includes(key));
}
checks.push('HTML and every referenced public asset are served without the key');
assert.equal((await worker.fetch(request('/.env.local'), env)).status, 404);
assert.equal((await worker.fetch(request('/server/index.js'), env)).status, 404);
checks.push('private files and server source are not public routes');

const realFetch = globalThis.fetch;
const providerCalls = [];
globalThis.fetch = async (url, options) => {
  providerCalls.push({ url: String(url), options });
  assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`);
  return Response.json({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } });
};
try {
  const payload = { sdp: 'offer-sdp', sessionId: 'hosted-test', mode: 'live', role: 'seller', speaker: 'Seller', context: [] };
  const liveRequest = callerOrigin => request('/api/live/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: callerOrigin }, body: JSON.stringify(payload),
  });
  assert.equal((await worker.fetch(liveRequest('https://unrelated.example'), env)).status, 403);
  assert.equal(providerCalls.length, 0);
  checks.push('foreign origins cannot start a paid live request');
  const live = await worker.fetch(liveRequest(origin), env);
  assert.equal(live.status, 201);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, 'https://api.openai.com/v1/live/sessions');
  assert.ok(!(await live.text()).includes(key));
  checks.push('same-site live sessions pass the hosted key only to OpenAI');
} finally { globalThis.fetch = realFetch; }

const manifest = JSON.parse(await readFile(new URL('../dist/.openai/hosting.json', import.meta.url), 'utf8'));
assert.equal(manifest.static, undefined);
checks.push('deployment declares the Worker instead of a static preview');
console.log(JSON.stringify({ status: 'passed', realProviderCalls: 0, checks }, null, 2));
