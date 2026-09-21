// @ts-check

/**
 * Source-private receipt for the one package name a failed validation attempt
 * actually observed. The failure object is the attempt identity: keying by the
 * executable definition would let reentrant validation or a later retry lend
 * its name to a different failure. A WeakMap keeps the receipt off both the
 * public Error and composition-problem shapes.
 */
const OBSERVED_PACKAGE_NAMES = new WeakMap();

const isReceiptKey = (value) => value !== null && typeof value === 'object';

/**
 * Run one complete validation attempt and bind its first completed name read
 * to the exact object it throws. A catch before name observation deletes any
 * older receipt for a reused error object; primitive throws remain unnamed.
 *
 * @template T
 * @param {(observeName: (name: any) => any) => T} validate
 * @returns {T}
 */
export function withPackageValidationReceipt(validate) {
  let nameObserved = false;
  let observedName;
  const observeName = (name) => {
    if (!nameObserved) {
      nameObserved = true;
      observedName = name;
    }
    return name;
  };

  try {
    return validate(observeName);
  } catch (error) {
    if (isReceiptKey(error)) {
      if (nameObserved) OBSERVED_PACKAGE_NAMES.set(error, observedName);
      else OBSERVED_PACKAGE_NAMES.delete(error);
    }
    throw error;
  }
}

/** Read one failed attempt's receipt without touching its declaration again. */
export function observedPackageValidationName(error) {
  return isReceiptKey(error) ? OBSERVED_PACKAGE_NAMES.get(error) : undefined;
}
