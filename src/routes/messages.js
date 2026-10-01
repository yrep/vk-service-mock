import { Hono } from 'hono';
import { firstDefined, httpError, isNumericRef } from '../repository.js';
import { readParams, toInt } from './util.js';

const MISSING_LOGIN = 'Invalid message format: missing login';

/**
 * Outgoing direction: our service -> VK.
 * The real adapter exposes POST /api/message/send with `{ login, msg: { to, text } }`;
 * this mock accepts that shape (and a couple of flat variants) and records the message.
 */
export function messagesRoutes() {
  const app = new Hono();

  app.post('/send', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);

    const login = firstDefined(params.login, params.group_id, params.group, params.group_alias, params.to_group);
    if (login === undefined) {
      return c.json({ success: false, error: MISSING_LOGIN }, 400);
    }

    const msg = params.msg && typeof params.msg === 'object' && !Array.isArray(params.msg) ? params.msg : params;
    const peerRef = firstDefined(msg.to, msg.thread, params.peer_id, params.peer, params.to);
    if (peerRef === undefined) {
      return c.json({ success: false, error: 'Invalid message format: missing peer_id (to or thread)' }, 400);
    }

    const group = ctx.repo.findGroup(login);
    if (!group) {
      return c.json({ success: false, error: `Group not found for login ${login}` }, 404);
    }

    // Peer must be a VK user the mock knows about, unless auto-creation is allowed.
    let vkUser = ctx.repo.findVkUser(peerRef);
    if (!vkUser) {
      const autoCreate = ctx.config.messages.auto_create_peer || !ctx.config.messages.require_known_peer;
      if (!autoCreate) {
        return c.json({ success: false, error: `VK user not found: ${peerRef} (create it with POST /vk-user/add or enable messages.auto_create_peer)` }, 404);
      }
      const raw = String(peerRef).trim();
      vkUser = isNumericRef(raw) ? ctx.repo.createVkUser({ id: Number(raw) }) : ctx.repo.createVkUser({ alias: raw });
    }

    const text = String(firstDefined(msg.text, params.text, params.message) ?? '');
    const content = Array.isArray(msg.content) ? msg.content : (Array.isArray(params.content) ? params.content : []);
    const chat = ctx.repo.ensureChat({ groupId: group.group_id, vkUserId: vkUser.id });
    const item = Number(chat.last_item) + 1;

    const stored = ctx.repo.insertMessage({
      direction: 'outgoing',
      group_id: group.group_id,
      chat_id: chat.id,
      from_id: group.group_id,
      to_id: vkUser.id,
      peer_id: vkUser.id,
      thread: vkUser.id,
      item,
      text,
      outgoing: true,
      hook_type: 'message',
      source: 'binder',
      payload: {
        received: params,
        random_id: firstDefined(msg.random_id, params.random_id) ?? null,
        content,
      },
    });

    return c.json({
      success: true,
      ok: true,
      message_id: item,
      peer_id: vkUser.id,
      group_id: group.group_id,
      group_alias: group.alias,
      chat_id: chat.id,
      chat_alias: chat.alias,
      mock_message_id: stored.id,
      text,
      created_at: stored.created_at,
      message: stored,
    });
  });

  // GET|POST /message/list
  const list = async (c) => {
    const ctx = c.get('ctx');
    const params = c.req.method === 'POST' ? await readParams(c) : Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const groupRef = firstDefined(params.group, params.group_id, params.group_alias);
    const peerRef = firstDefined(params.peer, params.peer_id, params.vk_user, params.from);
    const chatRef = firstDefined(params.chat, params.chat_id);
    const direction = firstDefined(params.direction);
    if (direction !== undefined && !['incoming', 'outgoing'].includes(String(direction))) {
      throw httpError(400, 'Parameter "direction" must be "incoming" or "outgoing"');
    }
    const group = groupRef === undefined ? null : ctx.repo.findGroup(groupRef);
    if (groupRef !== undefined && !group) throw httpError(404, `Group not found: "${groupRef}"`);
    const peer = peerRef === undefined ? null : ctx.repo.findVkUser(peerRef);
    if (peerRef !== undefined && !peer) throw httpError(404, `VK user not found: "${peerRef}"`);
    const chat = chatRef === undefined ? null : ctx.repo.findChat(chatRef);
    if (chatRef !== undefined && !chat) throw httpError(404, `Chat not found: "${chatRef}"`);

    const limit = toInt(params.limit, { field: 'limit', min: 1, max: 1000, fallback: 50 });
    const offset = toInt(params.offset, { field: 'offset', min: 0, fallback: 0 });
    const order = params.order === 'desc' ? 'desc' : 'asc';

    const messages = ctx.repo.listMessages({
      groupId: group?.group_id ?? null,
      peerId: peer?.id ?? null,
      chatId: chat?.id ?? null,
      direction: direction ?? null,
      limit,
      offset,
      order,
    });
    return c.json({ ok: true, count: messages.length, limit, offset, order, messages });
  };
  app.get('/list', list);
  app.post('/list', list);

  // GET|POST /message/:id — the mock's own message id
  app.get('/:id', (c) => {
    const ctx = c.get('ctx');
    const id = toInt(c.req.param('id'), { field: 'id', min: 1 });
    const message = ctx.repo.getMessage(id);
    if (!message) throw httpError(404, `Message not found: ${id}`);
    return c.json({ ok: true, message });
  });

  return app;
}

/** Conversations between our groups and external VK users. */
export function chatsRoutes() {
  const app = new Hono();

  const list = (c) => {
    const ctx = c.get('ctx');
    const groupRef = Object.fromEntries(new URL(c.req.url).searchParams.entries()).group;
    let groupId = null;
    if (groupRef !== undefined && groupRef !== '') {
      const group = ctx.repo.findGroup(groupRef);
      if (!group) throw httpError(404, `Group not found: "${groupRef}"`);
      groupId = group.group_id;
    }
    const chats = ctx.repo.listChats({ groupId });
    return c.json({ ok: true, count: chats.length, chats });
  };
  app.get('/list', list);
  app.post('/list', list);

  const get = (c) => {
    const ctx = c.get('ctx');
    const ref = c.req.param('chat');
    const chat = ctx.repo.findChat(ref);
    if (!chat) throw httpError(404, `Chat not found: "${ref}"`);
    const messages = ctx.repo.listMessages({ chatId: chat.id, limit: 20, order: 'desc' });
    return c.json({
      ok: true,
      chat,
      group: ctx.repo.groupById(chat.group_id),
      vk_user: ctx.repo.vkUserById(chat.vk_user_id),
      last_messages: messages.reverse(),
    });
  };
  app.get('/:chat', get);
  app.post('/:chat', get);

  return app;
}
