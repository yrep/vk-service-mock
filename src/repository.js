import {
  generateVkProfile,
  nextAlias,
  randomConfirmationCode,
  uniqueId,
} from './generators.js';
import { nowIso } from './db.js';

export function isNumericRef(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

function asBoolInt(value) {
  return value ? 1 : 0;
}

/**
 * A group row is always presented with `uuid`, which is the same value as
 * `binder_path` — the group's uuid in the service (last part of the hook URL).
 */
function hydrateGroup(row) {
  return row ? { ...row, uuid: row.binder_path } : null;
}

/** First value that is neither undefined, null nor a blank string. */
export function firstDefined(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

export class Repository {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.stmt = new Map();
  }

  q(sql) {
    if (!this.stmt.has(sql)) this.stmt.set(sql, this.db.prepare(sql));
    return this.stmt.get(sql);
  }

  /* ------------------------------------------------------------------ groups */

  groupById(groupId) {
    return hydrateGroup(this.q('SELECT * FROM group_integrations WHERE group_id = ? LIMIT 1').get(Number(groupId)) ?? null);
  }

  groupByAlias(alias) {
    return hydrateGroup(this.q('SELECT * FROM group_integrations WHERE alias = ? LIMIT 1').get(String(alias)) ?? null);
  }

  groupByBinderPath(binderPath) {
    return hydrateGroup(this.q('SELECT * FROM group_integrations WHERE binder_path = ? LIMIT 1').get(String(binderPath)) ?? null);
  }

  /** Accepts a numeric group_id or an alias. */
  findGroup(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const raw = String(ref).trim();
    if (isNumericRef(raw)) return this.groupById(Number(raw)) ?? this.groupByAlias(raw);
    return this.groupByAlias(raw);
  }

  firstGroup() {
    return hydrateGroup(this.q('SELECT * FROM group_integrations ORDER BY id ASC LIMIT 1').get() ?? null);
  }

  listGroups() {
    return this.q('SELECT * FROM group_integrations ORDER BY id ASC').all().map(hydrateGroup);
  }

  groupAliasExists(alias) {
    return Boolean(this.q('SELECT 1 FROM group_integrations WHERE alias = ? LIMIT 1').get(String(alias)));
  }

  nextGroupAlias() {
    const { group_prefix: prefix, pad } = this.config.generator.aliases;
    return nextAlias(prefix, Math.max(2, pad), (alias) => this.groupAliasExists(alias));
  }

  /**
   * `user_id`, `group_id`, `binder_path` and `token` are required: they come
   * from the service and cannot be invented — a group with a random uuid or a
   * made-up token is useless.
   */
  createGroup(input = {}) {
    const defaults = this.config.group_defaults;
    const now = nowIso();

    const userId = firstDefined(input.user_id, input.userId);
    const groupIdRaw = firstDefined(input.group_id, input.groupId, input.id);
    const binderPathRaw = firstDefined(input.binder_path, input.binderPath, input.uuid, input.binderPathUuid);
    const token = firstDefined(input.token, input.access_token, input.accessToken);

    const missing = [];
    if (userId === undefined) missing.push('user_id (bapi88 user id)');
    if (groupIdRaw === undefined) missing.push('group_id (VK community id)');
    if (binderPathRaw === undefined) missing.push('binder_path (the group uuid from the service)');
    if (token === undefined) missing.push('token (VK community access token from the service)');
    if (missing.length) {
      throw httpError(400, `Missing required group parameter(s): ${missing.join(', ')}. These values come from the service and are never generated.`);
    }

    const groupId = Number(String(groupIdRaw).trim());
    if (!Number.isInteger(groupId) || groupId <= 0) throw httpError(400, `group_id must be a positive integer, got "${groupIdRaw}"`);
    if (this.groupById(groupId)) throw httpError(409, `Group with group_id ${groupId} already exists`);

    const binderPath = String(binderPathRaw).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!binderPath) throw httpError(400, 'binder_path must not be empty');
    if (/[\s?#]/.test(binderPath)) throw httpError(400, `binder_path must be a single url path segment (uuid), got "${binderPathRaw}"`);
    const pathTaken = this.groupByBinderPath(binderPath);
    if (pathTaken) throw httpError(409, `binder_path "${binderPath}" is already used by group "${pathTaken.alias ?? pathTaken.group_id}"`);

    const requestedAlias = firstDefined(input.alias);
    const alias = requestedAlias === undefined ? this.nextGroupAlias() : String(requestedAlias).trim();
    if (this.groupAliasExists(alias)) throw httpError(409, `Group alias "${alias}" already exists`);

    const record = {
      user_id: String(userId),
      email: String(firstDefined(input.email, defaults.email) ?? ''),
      group_id: groupId,
      token: String(token),
      server_id: firstDefined(input.server_id, defaults.server_id) ?? null,
      confirmation_code: String(firstDefined(input.confirmation_code, defaults.confirmation_code) ?? randomConfirmationCode()),
      is_server_configured: asBoolInt(firstDefined(input.is_server_configured, defaults.is_server_configured) ?? 0),
      callbacks: firstDefined(input.callbacks, defaults.callbacks) ?? null,
      binder_path: binderPath,
      alias,
    };

    this.q(`
      INSERT INTO group_integrations
        (user_id, email, group_id, token, server_id, confirmation_code, is_server_configured, callbacks, binder_path, alias, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.user_id, record.email, record.group_id, record.token, record.server_id ?? null,
      record.confirmation_code, record.is_server_configured, record.callbacks, record.binder_path,
      record.alias, now, now,
    );

    return this.groupById(groupId);
  }

  /** Partial update: only the passed fields change. group_id is the identity and stays as is. */
  updateGroup(ref, input = {}) {
    const group = this.findGroup(ref);
    if (!group) throw httpError(404, `Group not found: ${ref}`);

    const updates = {};

    const alias = firstDefined(input.alias);
    if (input.alias !== undefined) {
      if (alias === undefined) throw httpError(400, 'alias must not be empty');
      const value = String(alias).trim();
      if (value !== group.alias) {
        if (this.groupAliasExists(value)) throw httpError(409, `Group alias "${value}" already exists`);
        updates.alias = value;
      }
    }

    const userId = firstDefined(input.user_id, input.userId);
    if (input.user_id !== undefined || input.userId !== undefined) {
      if (userId === undefined) throw httpError(400, 'user_id must not be empty');
      updates.user_id = String(userId);
    }

    const token = firstDefined(input.token, input.access_token, input.accessToken);
    if (input.token !== undefined || input.access_token !== undefined || input.accessToken !== undefined) {
      if (token === undefined) throw httpError(400, 'token must not be empty');
      updates.token = String(token);
    }

    const binderPathRaw = firstDefined(input.binder_path, input.binderPath, input.uuid);
    if (input.binder_path !== undefined || input.binderPath !== undefined || input.uuid !== undefined) {
      const binderPath = String(binderPathRaw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
      if (!binderPath) throw httpError(400, 'binder_path must not be empty');
      if (/[\s?#]/.test(binderPath)) throw httpError(400, `binder_path must be a single url path segment (uuid), got "${binderPathRaw}"`);
      if (binderPath !== group.binder_path) {
        const taken = this.groupByBinderPath(binderPath);
        if (taken) throw httpError(409, `binder_path "${binderPath}" is already used by group "${taken.alias ?? taken.group_id}"`);
        updates.binder_path = binderPath;
      }
    }

    if (input.email !== undefined) updates.email = String(firstDefined(input.email) ?? '');
    if (input.callbacks !== undefined) updates.callbacks = firstDefined(input.callbacks) ?? null;
    if (input.server_id !== undefined) updates.server_id = firstDefined(input.server_id) ?? null;
    if (input.confirmation_code !== undefined) updates.confirmation_code = String(firstDefined(input.confirmation_code) ?? '');
    if (input.is_server_configured !== undefined) updates.is_server_configured = asBoolInt(input.is_server_configured);

    const columns = Object.keys(updates);
    if (columns.length === 0) {
      throw httpError(400, 'Nothing to update: pass at least one of alias, user_id, token, binder_path/uuid, email, callbacks, server_id, confirmation_code, is_server_configured');
    }

    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    this.q(`UPDATE group_integrations SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...columns.map((column) => updates[column]), nowIso(), group.id);

    return this.groupById(group.group_id);
  }

  deleteGroup(ref) {
    const group = this.findGroup(ref);
    if (!group) throw httpError(404, `Group not found: ${ref}`);
    this.q('DELETE FROM group_integrations WHERE id = ?').run(group.id);
    return group;
  }

  /* ---------------------------------------------------------------- vk_user */

  vkUserById(id) {
    return this.q('SELECT * FROM vk_user WHERE id = ? LIMIT 1').get(Number(id)) ?? null;
  }

  vkUserByAlias(alias) {
    return this.q('SELECT * FROM vk_user WHERE alias = ? LIMIT 1').get(String(alias)) ?? null;
  }

  /** Accepts a numeric VK user id or an alias. */
  findVkUser(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const raw = String(ref).trim();
    if (isNumericRef(raw)) return this.vkUserById(Number(raw)) ?? this.vkUserByAlias(raw);
    return this.vkUserByAlias(raw);
  }

  listVkUsers() {
    return this.q('SELECT * FROM vk_user ORDER BY id ASC').all();
  }

  vkUserAliasExists(alias) {
    return Boolean(this.q('SELECT 1 FROM vk_user WHERE alias = ? LIMIT 1').get(String(alias)));
  }

  nextVkUserAlias() {
    const { vk_user_prefix: prefix, pad } = this.config.generator.aliases;
    return nextAlias(prefix, pad, (alias) => this.vkUserAliasExists(alias));
  }

  createVkUser(input = {}) {
    const now = nowIso();
    const explicitId = firstDefined(input.id, input.vk_id, input.user_id);
    const sex = firstDefined(input.sex);
    const profile = generateVkProfile(this.config.generator, { sex: sex === undefined ? undefined : Number(sex) });
    const requestedAlias = firstDefined(input.alias);
    const alias = requestedAlias === undefined ? this.nextVkUserAlias() : String(requestedAlias).trim();

    if (this.vkUserAliasExists(alias)) throw httpError(409, `VK user alias "${alias}" already exists`);

    let id;
    if (explicitId !== undefined) {
      id = Number(String(explicitId).trim());
      if (!Number.isInteger(id) || id <= 0) throw httpError(400, `VK user id must be a positive integer, got "${explicitId}"`);
      if (this.vkUserById(id)) throw httpError(409, `VK user ${id} already exists`);
    } else {
      id = uniqueId(this.config.generator.vk_user_id.min, this.config.generator.vk_user_id.max, (candidate) => Boolean(this.vkUserById(candidate)));
    }

    const record = {
      id,
      first_name: String(firstDefined(input.first_name, profile.first_name) ?? ''),
      last_name: String(firstDefined(input.last_name, profile.last_name) ?? ''),
      screen_name: String(firstDefined(input.screen_name) ?? `id${id}`),
      sex: Number(firstDefined(sex, profile.sex) ?? 0) || null,
      city: String(firstDefined(input.city, profile.city) ?? ''),
      alias,
    };

    this.q(`
      INSERT INTO vk_user (id, first_name, last_name, screen_name, sex, city, alias, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.first_name, record.last_name, record.screen_name, record.sex ?? null, record.city, record.alias, now, now);

    return this.vkUserById(id);
  }

  deleteVkUser(ref) {
    const user = this.findVkUser(ref);
    if (!user) throw httpError(404, `VK user not found: ${ref}`);
    this.q('DELETE FROM vk_user WHERE id = ?').run(user.id);
    return user;
  }

  /* ------------------------------------------------------------------ chats */

  chatById(id) {
    return this.q('SELECT * FROM chats WHERE id = ? LIMIT 1').get(Number(id)) ?? null;
  }

  chatByAlias(alias) {
    return this.q('SELECT * FROM chats WHERE alias = ? LIMIT 1').get(String(alias)) ?? null;
  }

  findChat(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const raw = String(ref).trim();
    if (isNumericRef(raw)) return this.chatById(Number(raw)) ?? this.chatByAlias(raw);
    return this.chatByAlias(raw);
  }

  chatByPeer(groupId, peerId) {
    return this.q('SELECT * FROM chats WHERE group_id = ? AND peer_id = ? LIMIT 1').get(Number(groupId), Number(peerId)) ?? null;
  }

  listChats({ groupId = null } = {}) {
    if (groupId !== null) return this.q('SELECT * FROM chats WHERE group_id = ? ORDER BY id ASC').all(Number(groupId));
    return this.q('SELECT * FROM chats ORDER BY id ASC').all();
  }

  chatAliasExists(alias) {
    return Boolean(this.q('SELECT 1 FROM chats WHERE alias = ? LIMIT 1').get(String(alias)));
  }

  nextChatAlias() {
    return nextAlias('chat', 2, (alias) => this.chatAliasExists(alias));
  }

  /** Gets or creates the (group, vk user) conversation. */
  ensureChat({ groupId, vkUserId }) {
    const peerId = Number(vkUserId);
    const existing = this.chatByPeer(groupId, peerId);
    if (existing) return existing;
    const now = nowIso();
    this.q(`
      INSERT INTO chats (group_id, peer_id, vk_user_id, alias, last_item, messages_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(Number(groupId), peerId, peerId, this.nextChatAlias(), now, now);
    return this.chatByPeer(groupId, peerId);
  }

  bumpChat(chatId, when) {
    const now = nowIso();
    this.q(`
      UPDATE chats
         SET last_item = last_item + 1,
             messages_count = messages_count + 1,
             last_message_at = ?,
             updated_at = ?
       WHERE id = ?
    `).run(when, now, chatId);
    return this.chatById(chatId);
  }

  /* --------------------------------------------------------------- messages */

  /**
   * Stores a message and bumps its chat counters.
   * direction: 'incoming' (VK -> us) | 'outgoing' (us -> VK)
   */
  insertMessage(input) {
    const chat = this.bumpChat(input.chat_id, input.mock_datetime ?? input.created_at ?? nowIso());
    const createdAt = input.created_at ?? nowIso();
    const result = this.q(`
      INSERT INTO messages
        (direction, group_id, chat_id, from_id, to_id, peer_id, thread, item, text, outgoing,
         hook_type, source, payload, delivery_url, delivery_ok, delivery_status, delivery_response, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.direction,
      Number(input.group_id),
      chat.id,
      Number(input.from_id),
      Number(input.to_id),
      input.peer_id === undefined || input.peer_id === null ? null : Number(input.peer_id),
      input.thread === undefined || input.thread === null ? null : Number(input.thread),
      input.item === undefined || input.item === null ? null : Number(input.item),
      String(input.text ?? ''),
      asBoolInt(input.outgoing),
      input.hook_type ?? null,
      input.source ?? null,
      input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
      input.delivery_url ?? null,
      input.delivery_ok === undefined || input.delivery_ok === null ? null : asBoolInt(input.delivery_ok),
      input.delivery_status ?? null,
      input.delivery_response ?? null,
      createdAt,
    );
    return this.getMessage(Number(result.lastInsertRowid));
  }

  setDelivery(messageId, delivery) {
    this.q(`
      UPDATE messages
         SET delivery_url = ?, delivery_ok = ?, delivery_status = ?, delivery_response = ?
       WHERE id = ?
    `).run(
      delivery.url ?? null,
      delivery.ok === undefined || delivery.ok === null ? null : asBoolInt(delivery.ok),
      delivery.status ?? null,
      (delivery.error ?? delivery.response ?? null),
      Number(messageId),
    );
    return this.getMessage(messageId);
  }

  getMessage(id) {
    const row = this.q('SELECT * FROM messages WHERE id = ? LIMIT 1').get(Number(id));
    return row ? hydrateMessage(row) : null;
  }

  listMessages({ groupId = null, peerId = null, chatId = null, direction = null, limit = 50, offset = 0, order = 'asc' } = {}) {
    const where = [];
    const params = [];
    if (groupId !== null) { where.push('group_id = ?'); params.push(Number(groupId)); }
    if (peerId !== null) { where.push('peer_id = ?'); params.push(Number(peerId)); }
    if (chatId !== null) { where.push('chat_id = ?'); params.push(Number(chatId)); }
    if (direction !== null) { where.push('direction = ?'); params.push(String(direction)); }
    const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`;
    return this.q(sql).all(...params, Number(limit), Number(offset)).map(hydrateMessage);
  }

  countMessages(filter = {}) {
    const where = [];
    const params = [];
    if (filter.groupId != null) { where.push('group_id = ?'); params.push(Number(filter.groupId)); }
    if (filter.direction != null) { where.push('direction = ?'); params.push(String(filter.direction)); }
    const sql = `SELECT COUNT(*) AS n FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return Number(this.q(sql).get(...params).n);
  }

  stats() {
    const count = (table) => Number(this.q(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    return {
      groups: count('group_integrations'),
      vk_users: count('vk_user'),
      chats: count('chats'),
      messages: count('messages'),
      messages_incoming: this.countMessages({ direction: 'incoming' }),
      messages_outgoing: this.countMessages({ direction: 'outgoing' }),
    };
  }
}

function hydrateMessage(row) {
  let payload = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  }
  return {
    ...row,
    outgoing: row.outgoing === 1,
    delivery_ok: row.delivery_ok === null || row.delivery_ok === undefined ? null : row.delivery_ok === 1,
    payload,
    chat_alias: row.chat_alias ?? null,
  };
}

export function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  return error;
}
