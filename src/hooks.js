import { randomInt, randomUUID } from 'node:crypto';
import { describeTime, renderTemplate } from './template.js';

/**
 * URL a generated hook is delivered to.
 *   1. `hook.target_url` may contain placeholders ({{binder_path}}, {{group_id}}, {{user_id}}, {{alias}});
 *   2. otherwise `hook.router_base_url` + '/' + group uuid (binder_path) — the
 *      same way the real service builds the binder url.
 */
export function resolveHookUrl(config, group) {
  const template = String(config.hook.target_url ?? '').trim();
  if (template) {
    return renderTemplate(template, {
      binder_path: group?.binder_path ?? '',
      uuid: group?.binder_path ?? '',
      group_id: group?.group_id ?? '',
      user_id: group?.user_id ?? '',
      alias: group?.alias ?? '',
    });
  }
  const base = String(config.hook.router_base_url ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const path = String(group?.binder_path ?? '').replace(/^\/+/, '');
  return path ? `${base}/${path}` : base;
}

/** Everything that can be referenced as {{placeholder}} in a message template. */
export function buildTemplateContext({ config, group, vkUser, chat, item, timeMicros, index, count }) {
  const groupId = Number(group.group_id);
  const vkUserId = Number(vkUser.id);
  return {
    // message / routing
    id: vkUserId,
    from: vkUserId,
    to: groupId,
    peer_id: vkUserId,
    thread: vkUserId,
    item,
    msg_id: item,
    chat_id: chat.id,
    chat_alias: chat.alias,
    // accounts
    group_id: groupId,
    group_alias: group.alias,
    group_user_id: group.user_id,
    vk_user_id: vkUserId,
    alias: vkUser.alias,
    first_name: vkUser.first_name,
    last_name: vkUser.last_name,
    screen_name: vkUser.screen_name,
    city: vkUser.city,
    sex: vkUser.sex,
    // helper values
    random: randomInt(100000, 999999),
    uuid: randomUUID(),
    index,
    count,
    source: config.hook.source,
    hook_type: config.hook.hook_type,
    ...describeTime(timeMicros),
  };
}

/** Payload of an incoming message hook — same shape the real service posts to the binder. */
export function buildHookPayload({ config, group, vkUser, item, text, timeMicros, outgoing = false }) {
  const groupId = Number(group.group_id);
  const vkUserId = Number(vkUser.id);
  return {
    from: outgoing ? groupId : vkUserId,
    to: outgoing ? vkUserId : groupId,
    time: timeMicros,
    text,
    source: config.hook.source,
    thread: vkUserId,
    item: String(item),
    outgoing: Boolean(outgoing),
    replyTo: null,
    content: [],
    hook_type: config.hook.hook_type,
    vkUser: outgoing
      ? null
      : {
        id: vkUserId,
        first_name: vkUser.first_name,
        last_name: vkUser.last_name,
        screen_name: vkUser.screen_name,
        sex: vkUser.sex,
        city: vkUser.city,
      },
  };
}

export function renderMessageText(template, context) {
  return renderTemplate(template, context);
}

/** Keys that may be used as {{placeholder}} in message templates. */
export const KNOWN_TEMPLATE_KEYS = Object.keys(buildTemplateContext({
  config: { hook: { source: '', hook_type: '' } },
  group: { group_id: 1, alias: '', user_id: '' },
  vkUser: { id: 1, alias: '', first_name: '', last_name: '', screen_name: '', city: '', sex: 0 },
  chat: { id: 1, alias: '' },
  item: 1,
  timeMicros: 0,
  index: 1,
  count: 1,
}));

/** POSTs the hook to the target URL; never throws. */
export async function deliverHook(config, payload, url) {
  if (!url) {
    return { url: null, ok: false, status: null, error: 'no hook target configured (hook.target_url / hook.router_base_url are empty)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.hook.timeout_ms) || 10000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.hook.headers ?? {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    const limit = Number(config.hook.response_max_length) || 2000;
    return {
      url,
      ok: response.ok,
      status: response.status,
      duration_ms: Date.now() - started,
      response: raw.length > limit ? `${raw.slice(0, limit)}…` : raw,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      duration_ms: Date.now() - started,
      error: error.name === 'AbortError' ? `timeout after ${config.hook.timeout_ms} ms` : String(error.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}
