import { ModelCategory } from '../download/types';
import { normalizePublicLanguageTag } from './normalize';

export type PublicLanguageHint = {
  iso6391Hint: string;
  id: string;
};

export type ResolvePublicLanguageHintsInput = {
  domain: ModelCategory;
  modelType?: string;
  /** Catalog id, archive stem, or on-disk folder basename (e.g. Supertonic 3 disambiguation). */
  modelKey?: string;
  /** Structured language rows from native detect bridge. */
  rawRows?: readonly PublicLanguageHint[];
};

function isPublicLanguageRow(value: unknown): value is PublicLanguageHint {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const row = value as { iso6391Hint?: unknown; id?: unknown };
  return typeof row.iso6391Hint === 'string' && typeof row.id === 'string';
}

/** Parse native bridge `languages` array into public hint rows. */
export function readPublicLanguageRows(raw: unknown): PublicLanguageHint[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const rows: PublicLanguageHint[] = [];
  for (const entry of raw) {
    if (!isPublicLanguageRow(entry)) {
      continue;
    }
    const iso6391Hint = entry.iso6391Hint.trim();
    const id = entry.id.trim();
    if (!iso6391Hint || !id) {
      continue;
    }
    rows.push({ iso6391Hint, id });
  }
  return rows;
}

/** Normalize `iso6391Hint` tags; preserve native `id` (modelOptions / API value). */
export function normalizePublicLanguageRows(
  rows: readonly PublicLanguageHint[]
): PublicLanguageHint[] {
  const out: PublicLanguageHint[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const normalized =
      normalizePublicLanguageTag(row.iso6391Hint) ?? row.iso6391Hint.trim();
    if (!normalized) {
      continue;
    }
    const key = `${normalized}\0${row.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ iso6391Hint: normalized, id: row.id.trim() });
  }
  return out;
}

/**
 * Normalize native structured `languages` rows from detect. Native bundles
 * `{ iso6391Hint, id }` from catalog SSOT; this layer only normalizes hints.
 */
export function publicLanguageHintsFromNative(
  input: ResolvePublicLanguageHintsInput
): PublicLanguageHint[] {
  return normalizePublicLanguageRows(input.rawRows ?? []);
}

/**
 * @deprecated Prefer {@link publicLanguageHintsFromNative} with structured native rows.
 */
export function resolvePublicLanguageHints(
  input: ResolvePublicLanguageHintsInput
): PublicLanguageHint[] {
  if (__DEV__) {
    const rows = input.rawRows ?? [];
    if (rows.length === 0) {
      console.warn(
        '[model-languages] resolvePublicLanguageHints: native returned no language rows; ' +
          'curated lists are appended in C++ detect when applicable.'
      );
    }
  }
  return publicLanguageHintsFromNative(input);
}
