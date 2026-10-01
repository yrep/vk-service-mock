import { randomInt } from 'node:crypto';

export function pick(list) {
  return list[randomInt(0, list.length)];
}

export function randomIntInclusive(min, max) {
  return randomInt(min, max + 1);
}

/** Unique numeric id inside [min,max], checked against `exists(id)`. */
export function uniqueId(min, max, exists, attempts = 500) {
  const span = max - min + 1;
  if (span < attempts) attempts = span;
  for (let i = 0; i < attempts; i += 1) {
    const candidate = randomIntInclusive(min, max);
    if (!exists(candidate)) return candidate;
  }
  // Deterministic fallback: first free id in range.
  for (let id = min; id <= max; id += 1) {
    if (!exists(id)) return id;
  }
  throw new Error(`No free id left in range ${min}..${max}`);
}

/** next free "prefix001"-style alias, given a `exists(alias)` predicate. */
export function nextAlias(prefix, pad, exists) {
  for (let n = 1; n < 100000; n += 1) {
    const alias = `${prefix}${String(n).padStart(pad, '0')}`;
    if (!exists(alias)) return alias;
  }
  throw new Error(`Cannot generate alias with prefix "${prefix}"`);
}

export function randomConfirmationCode(length = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

/**
 * VK-style profile for a new external user.
 * sex: 1 = female, 2 = male (same as VK).
 */
export function generateVkProfile(generator, { sex } = {}) {
  const resolvedSex = sex === 1 || sex === 2 ? Number(sex) : randomIntInclusive(1, 2);
  const female = resolvedSex === 1;
  const first_name = pick(female ? generator.first_names_female : generator.first_names_male);
  const last_name = pick(female ? generator.last_names_female : generator.last_names_male);
  return {
    first_name,
    last_name,
    sex: resolvedSex,
    city: pick(generator.cities),
    screen_name: null, // filled from the generated id
  };
}
