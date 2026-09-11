import {
  JSON_META_MAX_ARRAY_LENGTH,
  JSON_META_MAX_DEPTH,
  JSON_META_MAX_OBJECT_KEYS,
  sanitizeJsonMeta,
} from '../jsonMeta';

describe('sanitizeJsonMeta', () => {
  it('keeps scalars and nested object + array trees', () => {
    const out = sanitizeJsonMeta({
      durationMs: 1500,
      flag: true,
      missing: null,
      events: [
        { name: 'Speech', index: 0, prob: 0.9 },
        { name: 'Music', index: 1, prob: 0.4 },
      ],
      nested: { a: { b: 'ok' } },
    });
    expect(out).toEqual({
      durationMs: 1500,
      flag: true,
      missing: null,
      events: [
        { name: 'Speech', index: 0, prob: 0.9 },
        { name: 'Music', index: 1, prob: 0.4 },
      ],
      nested: { a: { b: 'ok' } },
    });
  });

  it('strips non-JSON values', () => {
    const out = sanitizeJsonMeta({
      ok: 'x',
      undef: undefined,
      fn: () => 1,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      host: new Date(),
    });
    expect(out).toEqual({ ok: 'x' });
  });

  it('drops reserved keys in publicView', () => {
    const out = sanitizeJsonMeta(
      {
        __segmentReason: 'manual',
        __segmentSource: 'append',
        durationMs: 10,
      },
      { publicView: true }
    );
    expect(out).toEqual({ durationMs: 10 });
  });

  it('keeps reserved keys without publicView', () => {
    const out = sanitizeJsonMeta({
      __segmentReason: 'manual',
      durationMs: 10,
    });
    expect(out).toEqual({
      __segmentReason: 'manual',
      durationMs: 10,
    });
  });

  it('keeps only string values under extra', () => {
    const out = sanitizeJsonMeta({
      extra: {
        voice: 'en',
        sid: 1,
        nested: { a: 1 },
      },
    });
    expect(out).toEqual({ extra: { voice: 'en' } });
  });

  it('drops values beyond max depth', () => {
    const deep = { a: { b: { c: { d: { e: 'too-deep' } } } } };
    const out = sanitizeJsonMeta(deep);
    // depth1=a obj, d2=b, d3=c, d4=d is object at max → dropped (no e)
    expect(out).toEqual({ a: { b: { c: {} } } });
    expect(JSON_META_MAX_DEPTH).toBe(4);
  });

  it('truncates arrays and object keys at soft limits', () => {
    const arr = Array.from(
      { length: JSON_META_MAX_ARRAY_LENGTH + 5 },
      (_, i) => i
    );
    const keys: Record<string, number> = {};
    for (let i = 0; i < JSON_META_MAX_OBJECT_KEYS + 5; i++) {
      keys[`k${i}`] = i;
    }
    const out = sanitizeJsonMeta({ arr, keys });
    expect(Array.isArray(out?.arr)).toBe(true);
    expect((out?.arr as number[]).length).toBe(JSON_META_MAX_ARRAY_LENGTH);
    expect(Object.keys(out?.keys as object).length).toBe(
      JSON_META_MAX_OBJECT_KEYS
    );
  });

  it('returns undefined for non-objects', () => {
    expect(sanitizeJsonMeta(null)).toBeUndefined();
    expect(sanitizeJsonMeta('x')).toBeUndefined();
    expect(sanitizeJsonMeta([1, 2])).toBeUndefined();
  });
});
