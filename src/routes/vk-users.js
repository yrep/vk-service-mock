import { Hono } from 'hono';
import { httpError } from '../repository.js';
import { readParams, toInt } from './util.js';

/** External VK users — mirrors `vk_user`. */
export function vkUsersRoutes() {
  const app = new Hono();

  // POST /vk-user/add
  app.post('/add', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const id = params.id ?? params.vk_id ?? params.user_id;
    const vkUser = ctx.repo.createVkUser({
      id: id === undefined || id === '' ? undefined : toInt(id, { field: 'id', min: 1 }),
      first_name: params.first_name,
      last_name: params.last_name,
      city: params.city,
      sex: params.sex === undefined || params.sex === '' ? undefined : toInt(params.sex, { field: 'sex', min: 0, max: 2 }),
      screen_name: params.screen_name,
      alias: params.alias,
    });
    return c.json({ ok: true, vk_user: vkUser }, 201);
  });

  // GET|POST /vk-user/list
  const list = (c) => {
    const vkUsers = c.get('ctx').repo.listVkUsers();
    return c.json({ ok: true, count: vkUsers.length, vk_users: vkUsers });
  };
  app.get('/list', list);
  app.post('/list', list);

  // POST /vk-user/delete  { id | alias }
  app.post('/delete', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const ref = params.id ?? params.vk_user ?? params.user_id ?? params.alias;
    if (ref === undefined || ref === '') throw httpError(400, 'Parameter "id" (VK user id or alias) is required');
    const vkUser = ctx.repo.deleteVkUser(ref);
    return c.json({ ok: true, deleted: vkUser });
  });

  // GET|POST /vk-user/delete/:id
  const remove = (c) => {
    const ctx = c.get('ctx');
    const vkUser = ctx.repo.deleteVkUser(c.req.param('id'));
    return c.json({ ok: true, deleted: vkUser });
  };
  app.get('/delete/:id', remove);
  app.post('/delete/:id', remove);

  // GET|POST /vk-user/:id
  const get = (c) => {
    const ctx = c.get('ctx');
    const ref = c.req.param('id');
    const vkUser = ctx.repo.findVkUser(ref);
    if (!vkUser) throw httpError(404, `VK user not found: "${ref}"`);
    return c.json({ ok: true, vk_user: vkUser });
  };
  app.get('/:id', get);
  app.post('/:id', get);

  return app;
}
