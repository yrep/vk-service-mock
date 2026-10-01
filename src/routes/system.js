import { Hono } from 'hono';
import { resetDatabase } from '../db.js';
import { resolveHookUrl } from '../hooks.js';
import { httpError } from '../repository.js';
import { seedDatabase } from '../seed.js';
import { readParams, toBool } from './util.js';

const ENDPOINTS = [
  { method: 'GET',  path: '/',                 description: 'This index' },
  { method: 'GET',  path: '/health',           description: 'Liveness probe' },
  { method: 'GET',  path: '/stats',            description: 'Row counts' },
  { method: 'POST', path: '/reset',            description: 'Wipe all data and re-create the seed (body: {"seed":true})' },

  { method: 'POST', path: '/hook/send',        description: 'Incoming VK message hook. Params: from, to, text, template, item, outgoing, deliver' },
  { method: 'POST', path: '/hook/batch',       description: 'Several incoming hooks. Params: from, to, count, delay, text, template, deliver' },

  { method: 'POST', path: '/group/add',        description: 'Create one of our accounts. Required: user_id, group_id, binder_path (uuid), token. Optional: alias, email, binder_path, callbacks, confirmation_code, server_id' },
  { method: 'GET',  path: '/group/list',       description: 'All our accounts' },
  { method: 'GET',  path: '/group/{group}',    description: 'One account by group_id or alias (includes the token and uuid)' },
  { method: 'POST', path: '/group/update/{group}', description: 'Partial update of an account (token, user_id, binder_path/uuid, alias, …)' },
  { method: 'POST', path: '/group/delete/{group}', description: 'Delete an account by group_id or alias' },

  { method: 'POST', path: '/vk-user/add',      description: 'Create an external VK user. Params: id, alias, first_name, last_name, city, sex, screen_name' },
  { method: 'GET',  path: '/vk-user/list',     description: 'All external VK users' },
  { method: 'GET',  path: '/vk-user/{user}',   description: 'One VK user by id or alias' },
  { method: 'POST', path: '/vk-user/delete/{user}', description: 'Delete a VK user by id or alias' },

  { method: 'POST', path: '/message/send',     description: 'Outgoing message (same contract as the real adapter). Body: {"login":"group01","msg":{"to":"vkuser111","text":"hi"}}' },
  { method: 'GET',  path: '/message/list',     description: 'Stored messages. Filters: group, peer, chat, direction, limit, offset, order' },
  { method: 'GET',  path: '/message/{id}',     description: 'One stored message by mock id' },

  { method: 'GET',  path: '/chat/list',        description: 'Conversations (filter: group)' },
  { method: 'GET',  path: '/chat/{chat}',      description: 'One conversation with the last messages' },
];

/** Service endpoints: index, health, stats, reset. */
export function systemRoutes({ version = '1.0.0' } = {}) {
  const app = new Hono();

  app.get('/', (c) => {
    const ctx = c.get('ctx');
    const { config, repo } = ctx;
    const groups = repo.listGroups().map((group) => ({
      alias: group.alias,
      group_id: group.group_id,
      user_id: group.user_id,
      uuid: group.binder_path,
      binder_path: group.binder_path,
      hook_url: resolveHookUrl(config, group),
      token_hint: `${String(group.token).slice(0, 12)}…`,
      token_url: `/group/${group.alias ?? group.group_id}`,
    }));

    return c.json({
      ok: true,
      service: 'vk-service-mock',
      version,
      config: {
        file: config.__configPath,
        base_url: config.server.public_url,
        host: config.server.host,
        port: Number(config.server.port),
        database: config.database.path,
        hook_target: config.hook.target_url,
        router_base_url: config.hook.router_base_url,
        hook_deliver: config.hook.deliver,
        text_template: config.hook.text_template,
        batch: { count: Number(config.batch.count), delay: Number(config.batch.delay) },
        messages: config.messages,
      },
      aliases: {
        groups: groups.map((group) => group.alias),
        vk_users: repo.listVkUsers().map((user) => user.alias),
      },
      groups,
      stats: repo.stats(),
      endpoints: ENDPOINTS,
    });
  });

  app.get('/health', (c) => {
    const ctx = c.get('ctx');
    return c.json({ ok: true, status: 'ok', uptime_s: Math.round(process.uptime()), database: ctx.config.database.path });
  });

  app.get('/stats', (c) => {
    const ctx = c.get('ctx');
    return c.json({ ok: true, stats: ctx.repo.stats() });
  });

  app.post('/reset', async (c) => {
    const ctx = c.get('ctx');
    if (!ctx.config.server.allow_reset) throw httpError(403, 'Reset is disabled (server.allow_reset = false)');
    const params = await readParams(c);
    const withSeed = toBool(params.seed, true);
    resetDatabase(ctx.db);
    const seeded = withSeed ? seedDatabase(ctx) : { groups: [], vk_users: [] };
    return c.json({ ok: true, reset: true, seeded: { groups: seeded.groups.length, vk_users: seeded.vk_users.length }, groups: seeded.groups, vk_users: seeded.vk_users });
  });

  return app;
}
