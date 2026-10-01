import { nowIso } from '../db.js';
import { buildHookPayload, buildTemplateContext, deliverHook, renderMessageText, resolveHookUrl } from '../hooks.js';
import { httpError, isNumericRef } from '../repository.js';
import { mockTimeMicros } from '../template.js';

/** Query string + JSON body + form body, merged (body wins). */
export async function readParams(c) {
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  let body = {};
  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('form-urlencoded') || contentType.includes('multipart/form-data')) {
      body = Object.fromEntries((await c.req.formData()).entries());
    } else {
      // An empty body is fine even when the client sets a JSON content-type
      // (typical for calls that pass everything in the query string).
      const raw = (await c.req.text())?.trim() ?? '';
      if (raw) body = JSON.parse(raw);
    }
  } catch {
    throw httpError(400, 'Request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
  return { ...query, ...body };
}

export function toBool(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
  throw httpError(400, `Cannot parse boolean from "${value}"`);
}

export function toInt(value, { field = 'value', min = null, max = null, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw httpError(400, `Parameter "${field}" is required`);
  }
  const num = Number(String(value).trim());
  if (!Number.isInteger(num)) throw httpError(400, `Parameter "${field}" must be an integer, got "${value}"`);
  if (min !== null && num < min) throw httpError(400, `Parameter "${field}" must be >= ${min}`);
  if (max !== null && num > max) throw httpError(400, `Parameter "${field}" must be <= ${max}`);
  return num;
}

export function toNumber(value, { field = 'value', min = null, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw httpError(400, `Parameter "${field}" is required`);
  }
  const num = Number(String(value).trim());
  if (!Number.isFinite(num)) throw httpError(400, `Parameter "${field}" must be a number, got "${value}"`);
  if (min !== null && num < min) throw httpError(400, `Parameter "${field}" must be >= ${min}`);
  return num;
}

/** Group must exist; an empty ref falls back to the first group in the mock. */
export function requireGroup(ctx, ref) {
  if (ref === undefined || ref === null || ref === '') {
    const first = ctx.repo.firstGroup();
    if (!first) throw httpError(400, 'No groups in the mock yet — create one with POST /group/add');
    return first;
  }
  const group = ctx.repo.findGroup(ref);
  if (!group) throw httpError(404, `Group not found: "${ref}" (create it with POST /group/add)`);
  return group;
}

export function requireVkUser(ctx, ref) {
  const user = ctx.repo.findVkUser(ref);
  if (!user) throw httpError(404, `VK user not found: "${ref}" (create it with POST /vk-user/add)`);
  return user;
}

/** Existing user, or a freshly generated one (explicit id/alias is honoured). */
export function resolveOrCreateVkUser(ctx, ref) {
  if (ref === undefined || ref === null || ref === '') return ctx.repo.createVkUser({});
  const existing = ctx.repo.findVkUser(ref);
  if (existing) return existing;
  const raw = String(ref).trim();
  return isNumericRef(raw) ? ctx.repo.createVkUser({ id: Number(raw) }) : ctx.repo.createVkUser({ alias: raw });
}

export function resolveDeliver(ctx, value) {
  const flag = toBool(value, undefined);
  return flag === undefined ? Boolean(ctx.config.hook.deliver) : flag;
}

export function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Renders the message text, builds the hook payload, stores the message
 * and (optionally) delivers the hook. Shared by /hook/send and /hook/batch.
 */
export async function sendHookMessage(ctx, {
  group,
  vkUser,
  text = null,
  template = null,
  outgoing = false,
  deliver = true,
  item = null,
  index = 1,
  count = 1,
}) {
  const chat = ctx.repo.ensureChat({ groupId: group.group_id, vkUserId: vkUser.id });
  const nextItem = item ?? Number(chat.last_item) + 1;
  const timeMicros = mockTimeMicros();
  const context = buildTemplateContext({ config: ctx.config, group, vkUser, chat, item: nextItem, timeMicros, index, count });
  const renderedText = renderMessageText(text ?? template ?? ctx.config.hook.text_template, context);
  const payload = buildHookPayload({ config: ctx.config, group, vkUser, item: nextItem, text: renderedText, timeMicros, outgoing });

  let message = ctx.repo.insertMessage({
    direction: outgoing ? 'outgoing' : 'incoming',
    group_id: group.group_id,
    chat_id: chat.id,
    from_id: payload.from,
    to_id: payload.to,
    peer_id: vkUser.id,
    thread: vkUser.id,
    item: nextItem,
    text: renderedText,
    outgoing,
    hook_type: ctx.config.hook.hook_type,
    source: ctx.config.hook.source,
    payload,
    created_at: nowIso(),
    mock_datetime: context.datetime,
  });

  const url = resolveHookUrl(ctx.config, group);
  let delivery;
  if (deliver) {
    delivery = await deliverHook(ctx.config, payload, url);
    message = ctx.repo.setDelivery(message.id, delivery);
  } else {
    delivery = { url, ok: null, status: null, skipped: true, reason: 'deliver=false' };
  }

  return { message, payload, delivery, chat: ctx.repo.chatById(chat.id) };
}
