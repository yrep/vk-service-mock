import { Hono } from 'hono';
import {
  readParams,
  requireGroup,
  resolveDeliver,
  resolveOrCreateVkUser,
  sendHookMessage,
  sleep,
  toBool,
  toInt,
  toNumber,
} from './util.js';

/**
 * Incoming direction: VK user -> our group.
 * The mock stores the message and POSTs a hook to the configured target.
 */
export function hooksRoutes() {
  const app = new Hono();

  // POST /hook/send
  app.post('/send', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const group = requireGroup(ctx, params.to);
    const vkUser = resolveOrCreateVkUser(ctx, params.from);

    const result = await sendHookMessage(ctx, {
      group,
      vkUser,
      text: params.text ?? null,
      template: params.template ?? null,
      outgoing: toBool(params.outgoing, false) ?? false,
      deliver: resolveDeliver(ctx, params.deliver),
      item: params.item === undefined || params.item === '' ? null : toInt(params.item, { field: 'item', min: 1 }),
    });

    return c.json({
      ok: true,
      group,
      vk_user: vkUser,
      chat: result.chat,
      message: result.message,
      payload: result.payload,
      delivery: result.delivery,
    });
  });

  // POST /hook/batch
  app.post('/batch', async (c) => {
    const ctx = c.get('ctx');
    const params = await readParams(c);
    const { config, repo } = ctx;

    const group = requireGroup(ctx, params.to ?? config.batch.to);
    const fromRef = params.from ?? config.batch.from;
    // Per spec: without `from` the batch runs as one brand new VK user.
    const vkUser = fromRef ? resolveOrCreateVkUser(ctx, fromRef) : repo.createVkUser({});

    const count = toInt(params.count, { field: 'count', min: 1, max: Number(config.batch.max_count), fallback: Number(config.batch.count) });
    const delay = toNumber(params.delay, { field: 'delay', min: 0, fallback: Number(config.batch.delay) });
    const deliver = resolveDeliver(ctx, params.deliver);
    const template = params.text ?? params.template ?? config.batch.text ?? config.hook.text_template;
    const outgoing = toBool(params.outgoing, false) ?? false;

    const items = [];
    const startedAt = Date.now();
    for (let index = 1; index <= count; index += 1) {
      const result = await sendHookMessage(ctx, {
        group,
        vkUser,
        text: `${template} [batch ${index}/${count}]`,
        outgoing,
        deliver,
        index,
        count,
      });
      items.push({
        index,
        message: result.message,
        payload: result.payload,
        delivery: result.delivery,
      });
      if (index < count) await sleep(delay * 1000);
    }

    const delivered = items.filter((item) => item.delivery?.ok === true).length;
    const failed = deliver ? items.length - delivered : 0;

    return c.json({
      ok: true,
      group,
      vk_user: vkUser,
      chat: repo.chatById(items[items.length - 1].message.chat_id),
      batch: {
        count,
        delay,
        deliver,
        template,
        duration_ms: Date.now() - startedAt,
        delivered,
        failed,
        skipped: deliver ? 0 : items.length,
      },
      items,
    });
  });

  return app;
}
