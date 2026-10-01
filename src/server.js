import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { KNOWN_TEMPLATE_KEYS } from './hooks.js';
import { createLogger } from './logger.js';
import { Repository } from './repository.js';
import { seedDatabase } from './seed.js';
import { usedPlaceholders } from './template.js';

/** Warns about {{typos}} in configured templates (unknown keys are kept as-is). */
function checkTemplates(config, logger) {
  const templates = [
    ['hook.text_template', config.hook.text_template],
    ['batch.text', config.batch.text],
  ];
  for (const [name, template] of templates) {
    if (typeof template !== 'string') continue;
    const unknown = usedPlaceholders(template).filter((key) => !KNOWN_TEMPLATE_KEYS.includes(key));
    if (unknown.length) logger.warn(`${name}: unknown placeholders ${unknown.map((k) => `{{${k}}}`).join(', ')}`);
  }
}

/**
 * Loads config, opens SQLite, seeds an empty database and starts HTTP.
 * Returns handles used by the CLI entry point and by the smoke test.
 */
export function startServer({ configPath, config: providedConfig, logger } = {}) {
  const config = providedConfig ?? loadConfig(configPath);
  const log = logger ?? createLogger({ quiet: config.server.quiet });
  const db = openDatabase(config.database.path);
  const repo = new Repository(db, config);
  const ctx = { config, db, repo, logger: log };

  checkTemplates(config, log);
  const seeded = seedDatabase(ctx);
  const app = createApp(ctx);

  const server = serve({
    fetch: app.fetch,
    hostname: config.server.host,
    port: Number(config.server.port),
  });

  /**
   * Resolves once the socket is actually listening, rejects on bind errors
   * (EADDRINUSE and friends) so the CLI can print a readable message
   * instead of crashing with an unhandled 'error' event.
   */
  const ready = new Promise((resolve, reject) => {
    if (server.listening) return resolve(server);
    server.once('listening', () => resolve(server));
    server.once('error', (error) => reject(error));
    return undefined;
  });
  // After startup the promise is settled; keep late errors from crashing the process.
  ready.catch(() => {});

  const close = () => new Promise((resolve) => {
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      resolve();
    });
  });

  return { app, server, ctx, config, db, repo, logger: log, seeded, ready, close };
}

/** Human-readable description of a failed bind. */
export function describeListenError(error, config) {
  const address = `${config.server.host}:${config.server.port}`;
  if (error?.code === 'EADDRINUSE') {
    return `Port ${address} is already in use — stop the process holding it or start on another port: pnpm start --port ${Number(config.server.port) + 1}`;
  }
  if (error?.code === 'EACCES') {
    return `Not allowed to listen on ${address} — try a port above 1024 or another host`;
  }
  if (error?.code === 'EADDRNOTAVAIL') {
    return `Address ${config.server.host} is not available on this machine — check server.host in config.yaml`;
  }
  return `Cannot start HTTP server on ${address}: ${error?.message ?? error}`;
}
