import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Built-in defaults. config.yaml is deep-merged on top of this object. */
export function defaultConfig() {
  return {
    server: {
      host: '127.0.0.1',
      port: 9680,
      public_url: 'http://127.0.0.1:9680',
      allow_reset: true,
      quiet: false,
    },
    database: {
      path: './data/vk-mock.sqlite',
    },
    hook: {
      // Where generated hooks go:
      //   1) target_url — fixed url, may contain {{binder_path}}/{{group_id}}/{{user_id}}/{{alias}};
      //   2) otherwise router_base_url + '/' + binder_path (the group uuid).
      target_url: null,
      router_base_url: null,
      deliver: true,
      timeout_ms: 10000,
      headers: {},
      source: 'vk-bot',
      hook_type: 'message',
      text_template: 'Сообщение от {{id}} {{item}}',
      response_max_length: 2000,
    },
    batch: {
      count: 5,
      max_count: 200,
      delay: 1, // seconds between messages
      from: null,
      to: null,
      text: null,
    },
    messages: {
      // /message/send (outgoing): peer is the VK user the group writes to
      require_known_peer: true,
      auto_create_peer: false,
    },
    generator: {
      cities: ['Москва', 'Санкт-Петербург', 'Новгород', 'Псков'],
      first_names_male: [
        'Александр', 'Дмитрий', 'Максим', 'Сергей', 'Андрей', 'Алексей', 'Иван',
        'Михаил', 'Никита', 'Егор', 'Артём', 'Роман', 'Павел', 'Владимир', 'Денис',
      ],
      first_names_female: [
        'Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Ирина', 'Екатерина',
        'Татьяна', 'Светлана', 'Юлия', 'Ксения', 'Дарья', 'Алина', 'Галина', 'Вера',
      ],
      last_names_male: [
        'Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Соколов', 'Лебедев', 'Козлов',
        'Новиков', 'Морозов', 'Петров', 'Волков', 'Соловьёв', 'Васильев', 'Зайцев', 'Павлов',
      ],
      last_names_female: [
        'Иванова', 'Смирнова', 'Кузнецова', 'Попова', 'Соколова', 'Лебедева', 'Козлова',
        'Новикова', 'Морозова', 'Петрова', 'Волкова', 'Соловьёва', 'Васильева', 'Зайцева', 'Павлова',
      ],
      vk_user_id: { min: 100000000, max: 999999999 },
      group_id: { min: 2000000000, max: 2299999999 },
      aliases: { vk_user_prefix: 'vkuser', group_prefix: 'group', pad: 3 },
    },
    group_defaults: {
      email: 'mock@example.com',
      server_id: null,
      confirmation_code: null, // null -> random 8 chars
      callbacks: 'message_new,message_reply,message_event',
      is_server_configured: 1,
    },
    seed: {
      // Groups are never invented: user_id, group_id, binder_path and token are
      // required and must be taken from the service. Add them here to have
      // the mock ready on the first start.
      groups: [],
      vk_users: [{ alias: 'vkuser111' }],
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function resolveFrom(baseDir, value) {
  if (typeof value !== 'string' || value === '') return value;
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export function resolveConfigPath(explicit) {
  const fromArg = explicit || process.env.MOCK_CONFIG;
  if (fromArg) return resolve(process.cwd(), fromArg);
  const local = join(process.cwd(), 'config.yaml');
  if (existsSync(local)) return local;
  const inRoot = join(PROJECT_ROOT, 'config.yaml');
  if (existsSync(inRoot)) return inRoot;
  return local; // will fall back to built-in defaults
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/** Load config.yaml, merge over defaults, apply env overrides and validate. */
export function loadConfig(explicitPath) {
  const configPath = resolveConfigPath(explicitPath);
  const hasFile = existsSync(configPath);
  const raw = hasFile ? (YAML.parse(readFileSync(configPath, 'utf8')) ?? {}) : {};
  const config = deepMerge(defaultConfig(), raw);
  const baseDir = hasFile ? dirname(configPath) : PROJECT_ROOT;

  config.__configPath = hasFile ? configPath : null;
  config.__baseDir = baseDir;
  config.database.path = resolveFrom(baseDir, config.database.path);

  if (process.env.MOCK_HOST) config.server.host = process.env.MOCK_HOST;
  if (process.env.MOCK_PORT) config.server.port = Number(process.env.MOCK_PORT);
  if (process.env.MOCK_DB) config.database.path = resolveFrom(process.cwd(), process.env.MOCK_DB);
  if (process.env.MOCK_HOOK_TARGET) config.hook.target_url = process.env.MOCK_HOOK_TARGET;
  config.hook.deliver = envBool('MOCK_HOOK_DELIVER', Boolean(config.hook.deliver));
  config.server.quiet = envBool('MOCK_QUIET', Boolean(config.server.quiet));

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const problems = [];
  const port = Number(config.server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`server.port must be 1..65535, got ${config.server.port}`);
  if (!config.server.host) problems.push('server.host must be a non-empty string');
  if (!config.database.path) problems.push('database.path must be a non-empty string');
  if (!Array.isArray(config.generator.cities) || config.generator.cities.length === 0) problems.push('generator.cities must be a non-empty list');
  if (typeof config.hook.text_template !== 'string' || !config.hook.text_template.trim()) problems.push('hook.text_template must be a non-empty string');
  for (const key of ['vk_user_id', 'group_id']) {
    const range = config.generator[key];
    if (!Number.isInteger(range?.min) || !Number.isInteger(range?.max) || range.min >= range.max) {
      problems.push(`generator.${key} must be {min,max} integers with min < max`);
    }
  }
  if (config.hook.target_url !== null && typeof config.hook.target_url !== 'string') problems.push('hook.target_url must be a string or null');
  if (config.hook.router_base_url !== null && typeof config.hook.router_base_url !== 'string') problems.push('hook.router_base_url must be a string or null');
  if (!Number.isInteger(Number(config.batch.count)) || Number(config.batch.count) < 1) problems.push('batch.count must be an integer >= 1');
  if (!Number.isFinite(Number(config.batch.delay)) || Number(config.batch.delay) < 0) problems.push('batch.delay must be a number >= 0');
  if (problems.length) {
    throw new Error(`Invalid configuration (${config.__configPath ?? 'defaults'}):\n - ${problems.join('\n - ')}`);
  }
}
