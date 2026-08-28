// @ts-check

/**
 * Source-private receipt for the one package name a validation attempt
 * actually observed. Composition needs it only when validation fails: reading
 * the declaration again can throw or name a different package. A WeakMap keeps
 * that fact off the public Error/problem shapes and releases it with the
 * executable definition.
 */
const OBSERVED_PACKAGE_NAMES = new WeakMap();

/** Start one validation attempt, invalidating any older receipt for this object. */
export function beginPackageValidation(definition) {
  if (definition && typeof definition === 'object') OBSERVED_PACKAGE_NAMES.delete(definition);
}

/** Record the exact result of the first completed `definition.name` read. */
export function rememberPackageValidationName(definition, name) {
  if (definition && typeof definition === 'object') OBSERVED_PACKAGE_NAMES.set(definition, name);
}

/** Read the receipt without touching the executable declaration again. */
export function observedPackageValidationName(definition) {
  return definition && typeof definition === 'object'
    ? OBSERVED_PACKAGE_NAMES.get(definition)
    : undefined;
}
