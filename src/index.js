#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { resolveHookUrl } from './hooks.js';
import { startServer, describeListenError } from './server.js';

function parseArgs(argv) {
  const options = { configPath: null, overrides: {}, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') options.configPath = argv[++i];
    else if (arg.startsWith('--config=')) options.configPath = arg.slice('--config='.length);
    else if (arg === '--port' || arg === '-p') options.overrides.port = Number(argv[++i]);
    else if (arg === '--host') options.overrides.host = argv[++i];
    else if (arg === '--no-deliver') options.overrides.deliver = false;
    else if (arg === '--deliver') options.overrides.deliver = true;
    else if (arg === '--target') options.overrides.target = argv[++i];
    else if (arg === '--quiet' || arg === '-q') options.overrides.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function printHelp() {
  process.stdout.write(`vk-service-mock — mock of our VK send/receive service

Usage: pnpm start [-- options]

  -c, --config <file>   Path to config.yaml (default: ./config.yaml or MOCK_CONFIG)
  -p, --port <port>     Override server.port (default 9680)
      --host <host>     Override server.host (default 127.0.0.1)
      --target <url>    Override hook.target_url
      --[no-]deliver    Force hook delivery on/off
  -q, --quiet           Do not log requests
  -h, --help            This help

Env overrides: MOCK_CONFIG, MOCK_HOST, MOCK_PORT, MOCK_DB, MOCK_HOOK_TARGET, MOCK_HOOK_DELIVER, MOCK_QUIET
`);
}

function banner({ config, repo, logger }) {
  const groups = repo.listGroups();
  const users = repo.listVkUsers();
  const base = config.server.public_url || `http://${config.server.host}:${config.server.port}`;
  const lines = [
    '',
    '  vk-service-mock',
    `  url        ${base}  (listening on ${config.server.host}:${config.server.port})`,
    `  config     ${config.__configPath ?? '(built-in defaults)'}`,
    `  database   ${config.database.path}`,
    `  hook       deliver=${config.hook.deliver} template="${config.hook.text_template}"`,
    `  hook url   ${config.hook.target_url ?? config.hook.router_base_url ?? '(not configured)'}`,
    `  template   {{id}} {{item}} {{datetime}} …`,
    '',
    `  groups (${groups.length}):`,
  ];
  for (const group of groups) {
    lines.push(`    ${String(group.alias).padEnd(10)} group_id=${group.group_id}  binder_path=${group.binder_path}`);
    lines.push(`    ${' '.repeat(10)} token=${group.token}`);
    lines.push(`    ${' '.repeat(10)} hook -> ${resolveHookUrl(config, group) ?? '(disabled)'}`);
  }
  lines.push(`  vk users (${users.length}): ${users.map((user) => `${user.alias}=${user.id}`).join(', ') || '—'}`);
  lines.push('');
  lines.push('  POST /hook/send?from=vkuser111&to=group01   — simulate an incoming VK message');
  lines.push('  POST /message/send  {"login":"group01","msg":{"to":"vkuser111","text":"hi"}}');
  lines.push('  GET  /                                      — index of all endpoints');
  lines.push('');
  logger.info(lines.join('\n'));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  let config;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    return process.exit(1);
  }
  if (options.overrides.port) config.server.port = options.overrides.port;
  if (options.overrides.host) config.server.host = options.overrides.host;
  if (options.overrides.target) config.hook.target_url = options.overrides.target;
  if (options.overrides.deliver !== undefined) config.hook.deliver = options.overrides.deliver;
  if (options.overrides.quiet) config.server.quiet = true;

  const logger = createLogger({ quiet: config.server.quiet });
  const handle = startServer({ config, logger });

  return handle.ready.then(() => {
    banner(handle);

    const shutdown = (signal) => {
      logger.info(`\n${signal} received, shutting down…`);
      handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((error) => {
    logger.error(describeListenError(error, config));
    process.exitCode = 1;
  });
}

function run() {
  try {
    const result = main();
    if (result?.catch) result.catch((error) => {
      process.stderr.write(`Fatal: ${error?.stack ?? error}\n`);
      process.exit(1);
    });
  } catch (error) {
    process.stderr.write(`Fatal: ${error?.stack ?? error}\n`);
    process.exit(1);
  }
}

run();
