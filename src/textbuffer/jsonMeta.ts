/**
 * Fabric-safe JSON-tree sanitizer for LiveText segment meta.
 *
 * Soft limits (drop on exceed, never throw on emit/read paths):
 * - max depth 4
 * - max array length 64
 * - max object keys per level 64
 */

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export const JSON_META_MAX_DEPTH = 4;
export const JSON_META_MAX_ARRAY_LENGTH = 64;
export const JSON_META_MAX_OBJECT_KEYS = 64;

export const RESERVED_SEGMENT_META_KEYS = new Set([
  '__segmentReason',
  '__segmentSource',
  '__segmentCreatedAtMs',
  '__segmentId',
  '__segmentLang',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(
  value: unknown,
  depth: number
): JsonValue | undefined {
  if (depth > JSON_META_MAX_DEPTH) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const t = typeof value;
  if (t === 'string' || t === 'boolean') {
    return value as string | boolean;
  }
  if (t === 'number') {
    return Number.isFinite(value as number) ? (value as number) : undefined;
  }
  if (
    t === 'undefined' ||
    t === 'function' ||
    t === 'symbol' ||
    t === 'bigint'
  ) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (depth >= JSON_META_MAX_DEPTH) {
      return undefined;
    }
    const out: JsonValue[] = [];
    const limit = Math.min(value.length, JSON_META_MAX_ARRAY_LENGTH);
    for (let i = 0; i < limit; i++) {
      const child = sanitizeJsonValue(value[i], depth + 1);
      if (child !== undefined) {
        out.push(child);
      }
    }
    return out;
  }

  if (!isPlainObject(value)) {
    // Host objects / class instances / Maps — drop.
    return undefined;
  }

  if (depth >= JSON_META_MAX_DEPTH) {
    return undefined;
  }

  const out: { [key: string]: JsonValue } = {};
  const keys = Object.keys(value);
  const limit = Math.min(keys.length, JSON_META_MAX_OBJECT_KEYS);
  for (let i = 0; i < limit; i++) {
    const key = keys[i]!;
    const child = sanitizeJsonValue(value[key], depth + 1);
    if (child !== undefined) {
      out[key] = child;
    }
  }
  return out;
}

function sanitizeExtra(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const extra: Record<string, string> = {};
  const keys = Object.keys(value);
  const limit = Math.min(keys.length, JSON_META_MAX_OBJECT_KEYS);
  for (let i = 0; i < limit; i++) {
    const key = keys[i]!;
    const v = value[key];
    if (typeof v === 'string') {
      extra[key] = v;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

export type SanitizeJsonMetaOptions = {
  /** Drop reserved `__segment*` keys for public event views. */
  publicView?: boolean;
};

/**
 * Project arbitrary meta into a plain JSON tree suitable for LiveText.
 */
export function sanitizeJsonMeta(
  input: unknown,
  options?: SanitizeJsonMetaOptions
): Record<string, JsonValue> | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }

  const publicView = options?.publicView === true;
  const out: Record<string, JsonValue> = {};
  const keys = Object.keys(input);
  const limit = Math.min(keys.length, JSON_META_MAX_OBJECT_KEYS);

  for (let i = 0; i < limit; i++) {
    const key = keys[i]!;
    if (publicView && RESERVED_SEGMENT_META_KEYS.has(key)) {
      continue;
    }

    const value = input[key];

    // TTS compatibility: extra stays a string-only map.
    if (key === 'extra') {
      const extra = sanitizeExtra(value);
      if (extra) {
        out.extra = extra;
      }
      continue;
    }

    const child = sanitizeJsonValue(value, 1);
    if (child !== undefined) {
      out[key] = child;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
