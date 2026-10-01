#!/usr/bin/env node
/**
 * End-to-end smoke test. Starts the mock in-process on a free port with a
 * temporary SQLite file, points hook.router_base_url at a local echo server
 * and checks the whole API surface.
 *
 *   pnpm smoke
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { resolveHookUrl } from '../src/hooks.js';
import { createLogger } from '../src/logger.js';
import { startServer } from '../src/server.js';

const MOCK_PORT = Number(process.env.SMOKE_PORT ?? 19680);
const ECHO_PORT = MOCK_PORT + 1;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;

// Seed group: user_id / group_id / binder_path (uuid) / token always come from the service.
const SEED_USER_ID = 'bapi88';
const SEED_GROUP_ID = 13663696;
const SEED_BINDER_PATH = '3fbd2115-5801-41f9-8009-2e5ed11d51be';
const SEED_TOKEN = 'vk1.a.seed-token-000000000000000000000000000000000000';

const received = [];
const checks = [];
let failures = 0;

function ok(name, fn) {
  checks.push({ name, fn });
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

const echo = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

function startEcho() {
  return new Promise((resolve) => echo.listen(ECHO_PORT, '127.0.0.1', resolve));
}

/* ------------------------------------------------------------------ checks */

ok('GET / returns the endpoint index', async () => {
  const { status, json } = await call('GET', '/');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.service, 'vk-service-mock');
  assert.ok(json.endpoints.length > 10);
  assert.equal(json.groups.length, 1, 'seed group exists');
  assert.ok(String(json.groups[0].token_hint).includes('…'));
  assert.equal(json.groups[0].uuid, SEED_BINDER_PATH);
  assert.equal(json.groups[0].hook_url, `http://127.0.0.1:${ECHO_PORT}/${SEED_BINDER_PATH}`);
});

ok('GET /health and /stats', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.json.ok, true);
  const stats = await call('GET', '/stats');
  assert.equal(stats.json.stats.groups, 1);
  assert.equal(stats.json.stats.vk_users, 1);
});

ok('GET /group/group01 exposes the token and the service uuid', async () => {
  const { status, json } = await call('GET', '/group/group01');
  assert.equal(status, 200);
  assert.equal(json.group.group_id, SEED_GROUP_ID);
  assert.equal(json.group.user_id, SEED_USER_ID);
  assert.equal(json.group.binder_path, SEED_BINDER_PATH);
  assert.equal(json.group.uuid, SEED_BINDER_PATH);
  assert.equal(json.group.token, SEED_TOKEN, 'the token is the one given, not generated');
});

ok('POST /group/add requires user_id, group_id, binder_path and token', async () => {
  const nothing = await call('POST', '/group/add', {});
  assert.equal(nothing.status, 400);
  assert.match(nothing.json.error, /user_id/);
  assert.match(nothing.json.error, /group_id/);
  assert.match(nothing.json.error, /binder_path/);
  assert.match(nothing.json.error, /token/);

  const noToken = await call('POST', '/group/add', { user_id: 'bapi1', group_id: 111, binder_path: 'uuid-111' });
  assert.equal(noToken.status, 400);
  assert.match(noToken.json.error, /token/);
  assert.doesNotMatch(noToken.json.error, /binder_path/);

  const partial = await call('POST', '/group/add', { user_id: 'bapi1', group_id: 111 });
  assert.equal(partial.status, 400);
  assert.match(partial.json.error, /binder_path/);
  assert.match(partial.json.error, /token/);
  assert.doesNotMatch(partial.json.error, /user_id/);

  const noUserId = await call('POST', '/group/add', { group_id: 112, binder_path: 'uuid-112', token: 't' });
  assert.equal(noUserId.status, 400);
  assert.match(noUserId.json.error, /user_id/);
});

ok('POST /group/add stores the given values and rejects duplicates', async () => {
  const created = await call('POST', '/group/add', {
    alias: 'group-test',
    user_id: 'bapi12345',
    group_id: 2222222,
    binder_path: 'bbbbbbbb-1111-2222-3333-444444444444',
    token: 'vk1.a.group-test-token',
  });
  assert.equal(created.status, 201, created.json?.error);
  assert.equal(created.json.group.user_id, 'bapi12345');
  assert.equal(created.json.group.group_id, 2222222);
  assert.equal(created.json.group.uuid, 'bbbbbbbb-1111-2222-3333-444444444444');
  assert.equal(created.json.group.token, 'vk1.a.group-test-token');
  assert.ok(created.json.group.confirmation_code.length === 8, 'confirmation_code is still generated');

  const sameGroupId = await call('POST', '/group/add', { user_id: 'bapi1', group_id: 2222222, binder_path: 'uuid-x', token: 't' });
  assert.equal(sameGroupId.status, 409);

  const samePath = await call('POST', '/group/add', { user_id: 'bapi1', group_id: 2222223, binder_path: 'bbbbbbbb-1111-2222-3333-444444444444', token: 't' });
  assert.equal(samePath.status, 409);
  assert.match(samePath.json.error, /binder_path/);
});

ok('POST /group/update changes only the passed fields', async () => {
  const before = (await call('GET', '/group/group-test')).json.group;

  const updated = await call('POST', '/group/update/group-test', { token: 'vk1.a.corrected-token' });
  assert.equal(updated.status, 200, updated.json?.error);
  assert.equal(updated.json.group.token, 'vk1.a.corrected-token');
  assert.equal(updated.json.group.user_id, before.user_id, 'other fields are untouched');
  assert.equal(updated.json.group.binder_path, before.binder_path);

  const renamed = await call('POST', '/group/update/group-test', { uuid: 'cccccccc-1111-2222-3333-444444444444', user_id: 'bapi999' });
  assert.equal(renamed.json.group.uuid, 'cccccccc-1111-2222-3333-444444444444');
  assert.equal(renamed.json.group.user_id, 'bapi999');

  const empty = await call('POST', '/group/update/group-test', {});
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /Nothing to update/);

  const emptyToken = await call('POST', '/group/update/group-test', { token: '' });
  assert.equal(emptyToken.status, 400);
  assert.match(emptyToken.json.error, /token/);

  const clash = await call('POST', '/group/update/group-test', { binder_path: SEED_BINDER_PATH });
  assert.equal(clash.status, 409);

  const missing = await call('POST', '/group/update/nope', { token: 'x' });
  assert.equal(missing.status, 404);
});

ok('hooks are delivered to router_base_url + the group uuid', async () => {
  received.length = 0;
  await call('POST', '/hook/send?from=vkuser111&to=group-test&deliver=true');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/cccccccc-1111-2222-3333-444444444444');

  received.length = 0;
  await call('POST', '/hook/send?from=555000111&to=group01&deliver=true');
  assert.equal(received[0].url, `/${SEED_BINDER_PATH}`);

  const removed = await call('POST', '/group/delete/group-test');
  assert.equal(removed.json.deleted.uuid, 'cccccccc-1111-2222-3333-444444444444');
});

ok('hook.target_url supports {{binder_path}} and plain urls', () => {
  const group = { binder_path: 'abc-123', group_id: 777, user_id: 'bapi7', alias: 'g7' };
  assert.equal(
    resolveHookUrl({ hook: { target_url: 'https://router.local/hook/{{binder_path}}', router_base_url: null } }, group),
    'https://router.local/hook/abc-123',
  );
  assert.equal(
    resolveHookUrl({ hook: { target_url: 'https://router.local/fixed', router_base_url: null } }, group),
    'https://router.local/fixed',
  );
  assert.equal(
    resolveHookUrl({ hook: { target_url: null, router_base_url: 'https://router.local/' } }, group),
    'https://router.local/abc-123',
  );
  assert.equal(resolveHookUrl({ hook: { target_url: null, router_base_url: null } }, group), null);
});

ok('POST /vk-user/add + /vk-user/{id} + delete', async () => {
  const created = await call('POST', '/vk-user/add', { first_name: 'Пётр', city: 'Псков', sex: 2 });
  assert.equal(created.status, 201);
  const user = created.json.vk_user;
  assert.equal(user.first_name, 'Пётр');
  assert.equal(user.city, 'Псков');
  assert.ok(user.last_name, 'last name generated');
  assert.equal(user.screen_name, `id${user.id}`);

  const fetched = await call('GET', `/vk-user/${user.id}`);
  assert.equal(fetched.json.vk_user.id, user.id);

  const byAlias = await call('GET', `/vk-user/${user.alias}`);
  assert.equal(byAlias.json.vk_user.id, user.id);

  const explicit = await call('POST', '/vk-user/add', { id: 229313008, first_name: 'Галя', last_name: 'Кротова', city: 'Санкт-Петербург', sex: 1 });
  assert.equal(explicit.json.vk_user.id, 229313008);

  const removed = await call('POST', `/vk-user/delete/${user.alias}`);
  assert.equal(removed.json.deleted.id, user.id);
  assert.equal((await call('GET', `/vk-user/${user.id}`)).status, 404);
});

ok('POST /hook/send builds the hook, stores it and delivers it', async () => {
  received.length = 0;
  const { status, json } = await call('POST', '/hook/send?from=vkuser111&to=group01');
  assert.equal(status, 200, json?.error);

  assert.equal(json.ok, true);
  assert.equal(json.delivery.ok, true, `delivery failed: ${JSON.stringify(json.delivery)}`);
  assert.equal(received.length, 1);
  const hook = received[0].body;
  assert.deepEqual(Object.keys(hook), ['from', 'to', 'time', 'text', 'source', 'thread', 'item', 'outgoing', 'replyTo', 'content', 'hook_type', 'vkUser']);
  assert.equal(hook.from, json.vk_user.id);
  assert.equal(hook.to, json.group.group_id);
  assert.equal(hook.source, 'vk-bot');
  assert.equal(hook.hook_type, 'message');
  assert.equal(hook.outgoing, false);
  assert.equal(hook.item, '1');
  assert.equal(hook.thread, json.vk_user.id);
  assert.equal(hook.text, `Сообщение от ${json.vk_user.id} 1`);
  assert.equal(hook.vkUser.first_name, json.vk_user.first_name);
  assert.ok(Number.isInteger(hook.time) && String(hook.time).length === 16, `time looks like microseconds, got ${hook.time}`);
  assert.equal(json.message.direction, 'incoming');
  assert.equal(json.message.delivery_status, 200);
  assert.equal(json.chat.alias, json.message.chat_alias ?? json.chat.alias);
});

ok('POST /hook/send with JSON body, custom template and a new user', async () => {
  received.length = 0;
  const before = (await call('GET', '/vk-user/list')).json.count;
  const { status, json } = await call('POST', '/hook/send', {
    from: 700000001,
    to: 'group01',
    text: 'Привет {{first_name}} из {{city}} — {{datetime}}',
  });
  assert.equal(status, 200, json?.error);
  assert.equal(json.vk_user.id, 700000001, 'explicit id is created on the fly');
  assert.equal((await call('GET', '/vk-user/list')).json.count, before + 1);
  assert.match(json.payload.text, /^Привет .+ из (Москва|Санкт-Петербург|Новгород|Псков) — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{4}$/);
  assert.equal(json.message.item, 1);
  assert.equal(received[0].body.text, json.payload.text);
});

ok('query-only calls work even with an empty JSON body', async () => {
  const emptyJsonBody = await fetch(`${BASE}/hook/send?from=vkuser111&to=group01&deliver=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(emptyJsonBody.status, 200, await emptyJsonBody.text());

  const brokenJson = await fetch(`${BASE}/hook/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"to":',
  });
  assert.equal(brokenJson.status, 400);
  assert.match((await brokenJson.json()).error, /not valid JSON/);
});

ok('POST /hook/send with no parameters creates a user and uses the first group', async () => {
  received.length = 0;
  const { status, json } = await call('POST', '/hook/send');
  assert.equal(status, 200, json?.error);
  assert.equal(json.group.alias, 'group01');
  assert.ok(json.vk_user.id > 0);
  assert.equal(json.delivery.ok, true);
  assert.equal(received[0].body.to, json.group.group_id);
});

ok('POST /hook/send validates unknown groups and honours deliver=false', async () => {
  const unknown = await call('POST', '/hook/send?to=nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.ok, false);

  received.length = 0;
  const local = await call('POST', '/hook/send?from=vkuser111&to=group01&deliver=false');
  assert.equal(local.status, 200);
  assert.equal(local.json.delivery.skipped, true);
  assert.equal(received.length, 0, 'nothing was delivered');
  assert.ok(local.json.message.id > 0);
});

ok('POST /hook/batch sends N messages with the batch suffix', async () => {
  received.length = 0;
  const { status, json } = await call('POST', '/hook/batch', { to: 'group01', count: 3, delay: 0, text: 'Пачка {{index}}/{{count}}' });
  assert.equal(status, 200, json?.error);
  assert.equal(json.items.length, 3);
  assert.equal(json.batch.delivered, 3);
  assert.equal(received.length, 3);
  json.items.forEach((item, index) => {
    assert.equal(item.message.item, index + 1);
    assert.equal(item.payload.text, `Пачка ${index + 1}/3 [batch ${index + 1}/3]`);
  });
  assert.notEqual(json.items[0].message.from_id, json.items[0].message.to_id);
});

ok('POST /message/send records an outgoing message', async () => {
  const peer = 229313008;
  const { status, json } = await call('POST', '/message/send', { login: 'group01', msg: { to: peer, thread: peer, text: 'Ответ из binder' } });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.peer_id, peer);
  assert.ok(json.message_id > 0);
  assert.equal(json.message.direction, 'outgoing');

  const viaAdapterPath = await call('POST', '/api/message/send', { login: 'group01', msg: { to: peer, text: 'Через /api/message/send' } });
  assert.equal(viaAdapterPath.status, 200);
  assert.equal(viaAdapterPath.json.success, true);

  const list = await call('GET', `/message/list?group=group01&direction=outgoing`);
  assert.ok(list.json.count >= 2);
  assert.equal(list.json.messages.at(-1).text, 'Через /api/message/send');
});

ok('POST /message/send returns errors for bad input', async () => {
  const noLogin = await call('POST', '/message/send', { msg: { to: 1, text: 'x' } });
  assert.equal(noLogin.status, 400);
  assert.equal(noLogin.json.success, false);
  assert.match(noLogin.json.error, /missing login/);

  const noPeer = await call('POST', '/message/send', { login: 'group01', msg: { text: 'x' } });
  assert.equal(noPeer.status, 400);
  assert.match(noPeer.json.error, /peer_id/);

  const noGroup = await call('POST', '/message/send', { login: 'group-nope', msg: { to: 1, text: 'x' } });
  assert.equal(noGroup.status, 404);
  assert.match(noGroup.json.error, /Group not found/);

  const noPeerUser = await call('POST', '/message/send', { login: 'group01', msg: { to: 999999999, text: 'x' } });
  assert.equal(noPeerUser.status, 404);
  assert.match(noPeerUser.json.error, /VK user not found/);
});

ok('message and chat listings work', async () => {
  const messages = await call('GET', '/message/list?limit=5&order=desc');
  assert.equal(messages.json.messages.length, 5);
  const single = await call('GET', `/message/${messages.json.messages[0].id}`);
  assert.equal(single.json.message.id, messages.json.messages[0].id);

  const chats = await call('GET', '/chat/list?group=group01');
  assert.ok(chats.json.count >= 1);
  const chat = await call('GET', `/chat/${chats.json.chats[0].alias}`);
  assert.equal(chat.json.chat.id, chats.json.chats[0].id);
  assert.ok(chat.json.last_messages.length > 0);

  const badDirection = await call('GET', '/message/list?direction=sideways');
  assert.equal(badDirection.status, 400);
});

ok('unknown path returns 404 JSON', async () => {
  const { status, json } = await call('GET', '/nope');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
});

ok('POST /reset wipes and re-seeds', async () => {
  const { json } = await call('POST', '/reset', { seed: true });
  assert.equal(json.ok, true);
  const stats = await call('GET', '/stats');
  assert.deepEqual(
    { groups: stats.json.stats.groups, vk_users: stats.json.stats.vk_users, messages: stats.json.stats.messages, chats: stats.json.stats.chats },
    { groups: 1, vk_users: 1, messages: 0, chats: 0 },
  );
});

/* -------------------------------------------------------------------- main */

const tempDir = mkdtempSync(join(tmpdir(), 'vk-mock-smoke-'));
const configPath = join(tempDir, 'config.yaml');
writeFileSync(configPath, [
  'server:',
  `  host: 127.0.0.1`,
  `  port: ${MOCK_PORT}`,
  `  public_url: http://127.0.0.1:${MOCK_PORT}`,
  '  quiet: true',
  'database:',
  `  path: ${JSON.stringify(join(tempDir, 'smoke.sqlite'))}`,
  'hook:',
  `  router_base_url: http://127.0.0.1:${ECHO_PORT}`,
  '  deliver: true',
  '  timeout_ms: 3000',
  'batch:',
  '  count: 3',
  '  delay: 0',
  'seed:',
  '  groups:',
  '    - alias: group01',
  `      user_id: ${SEED_USER_ID}`,
  `      group_id: ${SEED_GROUP_ID}`,
  `      binder_path: ${SEED_BINDER_PATH}`,
  `      token: ${SEED_TOKEN}`,
  '  vk_users:',
  '    - alias: vkuser111',
  '',
].join('\n'));

await startEcho();
const handle = startServer({ config: loadConfig(configPath), logger: createLogger({ quiet: true }) });
await handle.ready;

for (const check of checks) {
  try {
    await check.fn();
    process.stdout.write(`  ✓ ${check.name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`  ✗ ${check.name}\n      ${error.message}\n`);
  }
}

await handle.close();
echo.close();
rmSync(tempDir, { recursive: true, force: true });

process.stdout.write(`\n${checks.length - failures}/${checks.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
