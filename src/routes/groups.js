import { Hono } from 'hono';
import { httpError } from '../repository.js';
import { readParams, toBool, toInt } from './util.js';

/** Our accounts (VK communities) — mirrors `group_integrations`. */
export function groupsRoutes() {
  const app = new Hono();

  // POST /group/add
  app.post('/add', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const group = ctx.repo.createGroup({
      group_id: params.group_id ?? params.groupId ?? params.id,
      alias: params.alias,
      user_id: params.user_id,
      email: params.email,
      token: params.token,
      server_id: params.server_id === undefined || params.server_id === '' ? undefined : toInt(params.server_id, { field: 'server_id' }),
      confirmation_code: params.confirmation_code,
      callbacks: params.callbacks,
      binder_path: params.binder_path,
      is_server_configured: params.is_server_configured === undefined ? undefined : toBool(params.is_server_configured),
    });
    return c.json({ ok: true, group }, 201);
  });

  // GET|POST /group/list
  const list = (c) => {
    const groups = c.get('ctx').repo.listGroups();
    return c.json({ ok: true, count: groups.length, groups });
  };
  app.get('/list', list);
  app.post('/list', list);

  // POST /group/delete  { group | group_id | alias }
  app.post('/delete', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const ref = params.group ?? params.group_id ?? params.alias ?? params.id;
    if (ref === undefined || ref === '') throw httpError(400, 'Parameter "group" (group_id or alias) is required');
    const group = ctx.repo.deleteGroup(ref);
    return c.json({ ok: true, deleted: group });
  });

  // POST /group/update  { group | group_id | alias, ...поля }
  app.post('/update', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const ref = params.group ?? params.group_alias ?? params.group_id;
    if (ref === undefined || ref === '') throw httpError(400, 'Parameter "group" (group_id or alias) is required');
    const group = ctx.repo.updateGroup(ref, params);
    return c.json({ ok: true, group });
  });

  // POST /group/update/:group — частичное обновление (token, user_id, uuid, alias, …)
  app.post('/update/:group', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const group = ctx.repo.updateGroup(c.req.param('group'), params);
    return c.json({ ok: true, group });
  });

  // GET|POST /group/delete/:group
  const remove = (c) => {
    const ctx = c.get('ctx');
    const group = ctx.repo.deleteGroup(c.req.param('group'));
    return c.json({ ok: true, deleted: group });
  };
  app.get('/delete/:group', remove);
  app.post('/delete/:group', remove);

  // GET|POST /group/:group — full record, including the token
  const get = (c) => {
    const ctx = c.get('ctx');
    const ref = c.req.param('group');
    const group = ctx.repo.findGroup(ref);
    if (!group) throw httpError(404, `Group not found: "${ref}"`);
    return c.json({ ok: true, group });
  };
  app.get('/:group', get);
  app.post('/:group', get);

  return app;
}
