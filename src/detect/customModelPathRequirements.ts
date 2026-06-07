export type CustomModelPathFieldKind = 'file' | 'dir';

/** One config key the native engine accepts for custom init. */
export type CustomModelPathField = {
  readonly key: string;
  readonly required: boolean;
  readonly kind: CustomModelPathFieldKind;
};

/**
 * Native schema for one `(category, modelType)` pair.
 * `fields` preserves declaration order from the C++ requirement tables.
 */
export type CustomModelPathRequirements = {
  readonly fields: ReadonlyArray<CustomModelPathField>;
};

export function customModelPathFieldKeys(
  requirements: CustomModelPathRequirements
): string[] {
  return requirements.fields.map((field) => field.key);
}

export function requiredCustomModelPathFieldKeys(
  requirements: CustomModelPathRequirements
): string[] {
  return requirements.fields
    .filter((field) => field.required)
    .map((field) => field.key);
}
