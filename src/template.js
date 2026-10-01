const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

/**
 * Mock "message time": microseconds since epoch (VK dates are seconds,
 * the binder payload uses date * 1_000_000).
 */
export function mockTimeMicros(date = Date.now()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  return ms * 1000 + Math.floor(Math.random() * 1000);
}

/** {{datetime}} -> "2026-10-01 12:45:52.1234" (UTC), plus date/time/µs parts. */
export function describeTime(timeMicros) {
  const micro = timeMicros % 1_000_000;
  const date = new Date(Math.floor(timeMicros / 1000));
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const frac6 = pad(micro, 6);
  return {
    datetime: `${day} ${clock}.${frac6.slice(0, 4)}`,
    datetime_us: `${day} ${clock}.${frac6}`,
    datetime_iso: `${day}T${clock}.${frac6.slice(0, 3)}Z`,
    date: day,
    time: clock,
    timestamp: Math.floor(timeMicros / 1_000_000),
    timestamp_ms: Math.floor(timeMicros / 1000),
    time_micros: timeMicros,
  };
}

function getPath(ctx, path) {
  if (ctx == null) return undefined;
  if (Object.hasOwn(ctx, path)) return ctx[path];
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), ctx);
}

/**
 * Replaces {{key}} / {{a.b}} placeholders from ctx.
 * Unknown placeholders are left untouched so typos stay visible.
 */
export function renderTemplate(template, ctx) {
  return String(template ?? '').replace(PLACEHOLDER, (match, key) => {
    const value = getPath(ctx, key);
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

export function usedPlaceholders(template) {
  const found = new Set();
  for (const match of String(template ?? '').matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found];
}
