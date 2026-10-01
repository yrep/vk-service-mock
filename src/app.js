import { Hono } from 'hono';
import { groupsRoutes } from './routes/groups.js';
import { hooksRoutes } from './routes/hooks.js';
import { chatsRoutes, messagesRoutes } from './routes/messages.js';
import { systemRoutes } from './routes/system.js';
import { vkUsersRoutes } from './routes/vk-users.js';

export const VERSION = '1.0.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Builds the Hono application. `ctx` = { config, db, repo, logger }.
 * It is available in every handler via c.get('ctx').
 */
export function createApp(ctx) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('ctx', ctx);
    if (c.req.method === 'OPTIONS') return c.body(null, 204, CORS_HEADERS);
    const started = Date.now();
    await next();
    for (const [key, value] of Object.entries(CORS_HEADERS)) c.res.headers.set(key, value);
    if (!ctx.config.server.quiet) {
      ctx.logger.info(`${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - started}ms)`);
    }
  });

  app.route('/hook', hooksRoutes());
  app.route('/group', groupsRoutes());
  app.route('/vk-user', vkUsersRoutes());
  app.route('/message', messagesRoutes());
  app.route('/api/message', messagesRoutes()); // same contract path as the real adapter
  app.route('/chat', chatsRoutes());
  app.route('/', systemRoutes({ version: VERSION }));

  app.notFound((c) => c.json({ ok: false, success: false, error: `Unknown path: ${c.req.method} ${c.req.path}`, endpoints_hint: 'GET /' }, 404));

  app.onError((error, c) => {
    const status = Number(error?.status) || 500;
    if (status >= 500) ctx.logger.error(`${c.req.method} ${c.req.path} failed: ${error.message}`);
    else ctx.logger.warn(`${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json(
      { ok: false, success: false, error: error.message, ...(error.extra ?? {}) },
      status,
    );
  });

  return app;
}
