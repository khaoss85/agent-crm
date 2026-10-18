// @ts-check

import {
  AppError, ConflictError, NotFoundError, ValidationError, requireActor, requireQuantity,
} from '../../core/index.js';

/**
 * **Package credits — commercial's accounting, read from the appointment rows.**
 *
 * After a payment the customer holds N entries (ingressi): the selling path
 * resolves the count from the commercial listino product and stores it here
 * with `grantPackageEntries`, idempotent by source key (the payment
 * reference). Every appointment that happened scales one entry off: the
 * balance is always computed from the stored appointment rows, never from a
 * counter anyone could rewrite — a `done` appointment consumes one entry, a
 * `no-show` consumes one only on grants whose `noShowConsumes` rule says so,
 * and anything not terminal consumes nothing.
 *
 * **Reuse, not duplication.**
 *
 * - The customer is the ADR-030 opaque envelope — `subjectResource`,
 *   `subjectId`, `subjectOwner`, `subjectOwnerPackage`, `subjectLabel` — the
 *   same shape `packages/work`, `packages/customer-data` and
 *   `packages/appointments` store. Nothing here copies a contact or a company,
 *   and no customer master table is created.
 * - The entry count is resolved by the selling path from the commercial
 *   listino and stored as agreed: a later listino change never rewrites a
 *   granted package, the same snapshot rule appointments apply to prices.
 * - Appointments are read, never written: this package advances no booking,
 *   and the appointment rows stay the appointments package's evidence.
 *
 * **The one deliberate absence of a `requires` edge.** The balance reads the
 * appointments package's `appointment` module through the caller's own modules
 * view — the same optional-read shape `commercial-quotes@2` uses for the
 * `quote-version-term` module a project may never have applied. Declaring a
 * hard `requires` on appointments would refuse to start every commercial-only
 * composition; instead, grants exist without appointments composed, and the
 * balance answers `available: false` with the reason when grants exist but
 * their consumption cannot be read. That is the customer-data absence
 * doctrine: never a silent zero where consumption may hide.
 */

export const PACKAGE_CREDIT_MODULE = 'package-credit';

export const PACKAGE_CREDITS_CONTRACT = 1;

/** Appointment states that scale an entry off a grant. `done` always does. */
export const CONSUMING_DONE_STATE = 'done';

/** The configurable no-show state: consumed only where the grant says so. */
export const NOSHOW_STATE = 'no-show';

const MAX_SOURCE_KEY = 200;
const MAX_ID = 200;
const MAX_LABEL = 200;
const MAX_PRODUCT_KEY = 48;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;
const PRODUCT_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** @param {unknown} value @param {string} field @param {number} max */
function safeText(value, field, max) {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`, field);
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`${field} is required`, field);
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError(`${field} must not contain control characters or line breaks`, field);
  }
  return trimmed;
}

/** @param {unknown} value @param {string} field @param {number} max */
function optionalSafeText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  return safeText(value, field, max);
}

/**
 * The ADR-030 opaque subject envelope, the same shape appointments validate:
 * the profile, the booking and the grant all name the customer the same way,
 * so the balance can join them without a master table.
 *
 * @param {unknown} value
 */
export function validateCreditSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('subject is required', 'subject');
  }
  const subject = /** @type {any} */ (value);
  const resource = safeText(subject.resource, 'subject.resource', 64);
  if (!RESOURCE_RE.test(resource)) {
    throw new ValidationError('subject.resource must be a canonical resource name', 'subject.resource');
  }
  const id = safeText(subject.id, 'subject.id', MAX_ID);
  const owner = subject.owner;
  if (owner !== 'host' && owner !== 'package') {
    throw new ValidationError('subject.owner must be "host" or "package"', 'subject.owner');
  }
  let ownerPackage = null;
  if (owner === 'package') {
    ownerPackage = safeText(subject.ownerPackage, 'subject.ownerPackage', 64);
    if (!PACKAGE_RE.test(ownerPackage)) {
      throw new ValidationError('subject.ownerPackage must be a canonical package name', 'subject.ownerPackage');
    }
  } else if (subject.ownerPackage !== undefined && subject.ownerPackage !== null) {
    throw new ValidationError(
      'subject.ownerPackage is not allowed when subject.owner is "host"', 'subject.ownerPackage',
    );
  }
  return {
    resource,
    id,
    owner,
    ownerPackage,
    label: optionalSafeText(subject.label, 'subject.label', MAX_LABEL),
  };
}

/** Where a grant came from. Caller-asserted, exactly like a capability's `consumer`. */
function validateSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('source is required', 'source');
  }
  const source = /** @type {any} */ (value);
  const pkg = safeText(source.package, 'source.package', 64);
  if (pkg !== 'host' && !PACKAGE_RE.test(pkg)) {
    throw new ValidationError('source.package must be "host" or a canonical package name', 'source.package');
  }
  const action = safeText(source.action, 'source.action', 64);
  if (!RESOURCE_RE.test(action)) {
    throw new ValidationError('source.action must be a canonical action name', 'source.action');
  }
  return { package: pkg, action };
}

/** @param {unknown} value @param {string} field */
function validateSourceKey(value, field) {
  const key = safeText(value, field, MAX_SOURCE_KEY);
  if (!SOURCE_KEY_RE.test(key)) {
    throw new ValidationError(`${field} must be a canonical business identity`, field);
  }
  return key;
}

/**
 * Resolve a module without letting the registry's own miss become the answer:
 * `ModuleRegistry.get` throws `NotFoundError` for an unregistered name, so an
 * optional read must catch rather than chain — the same shape appointments
 * use for its own optional resolution.
 *
 * @param {any} modules @param {string} name
 */
export function resolveCreditModule(modules, name) {
  try {
    return modules?.get?.(name) ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** @param {{credit?: string, appointment?: string}} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    credit: moduleNames.credit ?? PACKAGE_CREDIT_MODULE,
    appointment: moduleNames.appointment ?? 'appointment',
  };
}

/**
 * Storage returns booleans as stored: SQLite keeps them as 0/1 integers, so
 * every flag read compares normalized — the same `=== true || === 1` shape
 * the terms code uses for its own stored booleans.
 *
 * @param {unknown} value
 */
function isTrue(value) {
  return value === true || value === 1;
}

/** @param {{modules: any, names: {credit: string}}} context */
function creditService(context) {
  const service = resolveCreditModule(context.modules, context.names.credit)?.service;
  if (!service?.createManaged || typeof service.listWhere !== 'function') {
    throw new AppError(
      'The commercial package is installed without its "package-credit" records. '
        + 'Apply the manifest with `crm module create` before composing it.',
      { code: 'COMMERCIAL_STORAGE_INVALID', status: 500 },
    );
  }
  return service;
}

/** The read half: a balance never writes, so it must not require a writer. */
function creditReader(context) {
  const service = resolveCreditModule(context.modules, context.names.credit)?.service;
  if (!service || typeof service.listWhere !== 'function') {
    throw new AppError(
      'The commercial package is installed without its "package-credit" records. '
        + 'Apply the manifest with `crm module create` before composing it.',
      { code: 'COMMERCIAL_STORAGE_INVALID', status: 500 },
    );
  }
  return service;
}

/**
 * **Bind provenance to the caller, not to caller text.** The registry
 * resolves the consumer against this package's own offered capability and the
 * capability hands it here; when present it IS the provenance, and a request
 * asserting a different package is refused rather than quietly corrected —
 * the same binding the booking path applies to appointment sources. A host
 * caller passing no consumer may only assert `host`.
 */
function bindSourcePackage(source, consumer) {
  const bound = typeof consumer === 'string' && consumer !== '' ? consumer : 'host';
  if (source.package !== bound) {
    throw new AppError(
      `A package credit grant by "${bound}" may not record source.package "${source.package}": provenance is bound to the `
        + `${consumer ? 'package the registry resolved as the consumer' : 'host, because no package consumer opened this capability'}, `
        + 'not to the request body.',
      { code: 'COMMERCIAL_PACKAGE_CREDIT_SOURCE_MISMATCH', status: 403, details: { asserted: source.package, bound } },
    );
  }
  return { package: bound, action: source.action };
}

/**
 * The framework's normalized unique-constraint refusal, recognized so the loser
 * of a race replays the winner's row instead of surfacing driver text. Matched
 * on the typed `ConflictError`, never on message text.
 *
 * @param {unknown} error
 */
export function isUniqueConflict(error) {
  if (!(error instanceof ConflictError)) return false;
  return /** @type {any} */ (error).details?.transient !== true;
}

/** @param {unknown} request */
export function validatePackageCreditGrant(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a package credit grant object is required', 'request');
  }
  const value = /** @type {any} */ (request);
  const productKey = safeText(value.productKey, 'productKey', MAX_PRODUCT_KEY);
  if (!PRODUCT_KEY_RE.test(productKey)) {
    throw new ValidationError(
      'productKey must be the listino product key (lowercase slug, letters, digits, hyphens, at most 48 characters)',
      'productKey',
    );
  }
  for (const flag of ['allowNegative', 'noShowConsumes']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
      throw new ValidationError(`${flag} must be a boolean when given`, flag);
    }
  }
  return {
    sourceKey: validateSourceKey(value.sourceKey, 'sourceKey'),
    subject: validateCreditSubject(value.subject),
    productKey,
    // The shared quantity bound, not a local limit: a package holds at least
    // one entry, and the bound caps typos rather than stock.
    totalEntries: requireQuantity(value.totalEntries, 'totalEntries'),
    // The explicit choice the floor rule asks for: only a grant carrying
    // `allowNegative: true` may be driven below zero. Absent means false.
    allowNegative: value.allowNegative === true,
    // The configurable no-show rule, stored on the grant the sale configured:
    // a no-show consumes an entry only where this is true. Absent means a
    // no-show costs the customer nothing.
    noShowConsumes: value.noShowConsumes === true,
    source: validateSource(value.source),
  };
}

/**
 * Same key, same grant → the row that already exists. Same key, different
 * grant → 409 naming the fields, so recorded evidence is never overwritten.
 */
const BOOLEAN_GRANT_FIELDS = new Set(['allowNegative', 'noShowConsumes']);

function replayOrConflict(existing, submitted) {
  const conflictingFields = Object.keys(submitted)
    .filter((field) => {
      if (BOOLEAN_GRANT_FIELDS.has(field)) return isTrue(existing[field]) !== isTrue(submitted[field]);
      return (existing[field] ?? null) !== (submitted[field] ?? null);
    })
    .sort();
  if (conflictingFields.length === 0) return existing;
  throw new AppError(
    'A package credit grant already exists for this source key with a different '
      + `${conflictingFields.join(' and ')}; it is not overwritten. Read the existing row, or use a new source key for a new grant.`,
    { code: 'COMMERCIAL_PACKAGE_CREDIT_CONFLICT', status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/**
 * Grant N entries to one customer: the row a confirmed payment stores. The
 * source key is the payment reference, so a webhook redelivery replays the
 * grant rather than doubling the entries. Idempotent by source key.
 *
 * @param {{modules: any, moduleNames?: {credit?: string, appointment?: string}, actor: unknown, now?: () => string, consumer?: string}} context
 * @param {unknown} request
 */
export async function grantPackageEntries(context, request) {
  const names = resolvedNames(context.moduleNames);
  const grants = creditService({ modules: context.modules, names });
  const actor = context.actor;
  const who = requireActor(actor);
  const input = validatePackageCreditGrant(request);
  const source = bindSourcePackage(input.source, context.consumer);
  const now = typeof context.now === 'function' ? context.now() : new Date().toISOString();
  const submitted = {
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    productKey: input.productKey,
    totalEntries: input.totalEntries,
    allowNegative: input.allowNegative,
    noShowConsumes: input.noShowConsumes,
    sourcePackage: source.package,
    sourceAction: source.action,
  };
  const existing = (await grants.listWhere({ sourceKey: input.sourceKey }))[0];
  if (existing) {
    return { grant: replayOrConflict(existing, submitted), replayed: true };
  }
  try {
    const grant = await grants.createManaged({
      sourceKey: input.sourceKey,
      ...submitted,
      subjectLabel: input.subject.label,
      grantedAt: now,
      actorType: who.type,
      actorId: who.id,
    }, { actor });
    return { grant, replayed: false };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await grants.listWhere({ sourceKey: input.sourceKey }))[0];
    if (!raced) throw error;
    return { grant: replayOrConflict(raced, submitted), replayed: true };
  }
}

/**
 * The appointments that scale an entry off, oldest decision first. Only
 * terminal states the grant rules name: `done` always, `no-show` where the
 * grant says so. Anything else — booked, confirmed, cancelled — has not
 * happened and costs nothing.
 *
 * A `done` or `no-show` row whose decision instant cannot be proven is a
 * corrupt witness, never a free pass: the balance refuses rather than
 * guessing which grant it belongs to — the same fail-closed rule the booking
 * path applies to an unprovable held slot.
 *
 * @param {Array<any>} rows the subject's appointment rows
 */
export function consumingAppointments(rows) {
  const consuming = [];
  for (const row of rows ?? []) {
    if (row?.status !== CONSUMING_DONE_STATE && row?.status !== NOSHOW_STATE) continue;
    const ms = Date.parse(row.decidedAt);
    if (!Number.isFinite(ms)) {
      throw new AppError(
        `The appointment "${typeof row.id === 'string' && row.id !== '' ? row.id : 'unknown'}" is ${row.status} `
          + 'but carries no provable decision instant: the balance cannot place it against any grant, so it is refused rather than ignored.',
        {
          code: 'COMMERCIAL_PACKAGE_CREDIT_UNPROVABLE',
          status: 500,
          details: { rowId: typeof row.id === 'string' ? row.id : null, status: row.status ?? null },
        },
      );
    }
    consuming.push({ id: row.id, status: row.status, decidedMs: ms });
  }
  // Deterministic: oldest decision first; a done and a no-show decided in the
  // same instant allocate in that order, and the row id breaks full ties.
  consuming.sort((a, b) => (
    a.decidedMs - b.decidedMs
    || (a.status === b.status ? 0 : a.status === CONSUMING_DONE_STATE ? -1 : 1)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  ));
  return consuming;
}

/**
 * Spend the consuming appointments across the subject's grants, oldest grant
 * first. A `done` appointment spends from the earliest grant decided after it
 * was granted that still holds entries; a `no-show` spends only from such a
 * grant whose `noShowConsumes` rule says so. Past every grant's entries the
 * remainder lands on the earliest `allowNegative` grant — the explicit choice
 * — and only past those, or with none, is counted `uncovered`: the balance
 * then floors at zero instead of going negative on its own.
 *
 * @param {Array<any>} grants the subject's grant rows, oldest first — the
 * caller orders them, because FIFO is the contract, not a sort hidden inside
 * @param {Array<{id: any, status: string}>} consuming
 */
export function allocateConsumption(grants, consuming) {
  const ledgers = grants.map((grant) => ({ grant, used: 0 }));
  let uncovered = 0;
  for (const appointment of consuming) {
    const wantsNoShow = appointment.status === NOSHOW_STATE;
    const eligible = (ledger) => {
      // Granted after the appointment was decided: a later package never
      // pays for an earlier session. (Grant instants are proven before this
      // runs; see readPackageBalance.)
      if (Date.parse(ledger.grant.grantedAt) > appointment.decidedMs) return false;
      if (wantsNoShow && !isTrue(ledger.grant.noShowConsumes)) return false;
      return true;
    };
    const withRoom = ledgers.find((ledger) => eligible(ledger) && ledger.used < ledger.grant.totalEntries);
    if (withRoom) {
      withRoom.used += 1;
      continue;
    }
    const negative = ledgers.find((ledger) => eligible(ledger) && isTrue(ledger.grant.allowNegative));
    if (negative) {
      negative.used += 1;
      continue;
    }
    uncovered += 1;
  }
  return { ledgers, uncovered };
}

/**
 * Read one customer's package balance: granted entries minus the appointments
 * that happened, allocated oldest grant first. Never stored — the grants and
 * the appointment rows are the truth, and this is their projection.
 *
 * @param {{modules: any, moduleNames?: Record<string, string>}} context
 * @param {unknown} subject the ADR-030 envelope
 */
export async function readPackageBalance(context, subject) {
  const names = resolvedNames(context.moduleNames);
  const grants = creditReader({ modules: context.modules, names });
  const who = validateCreditSubject(subject);
  const rows = (await grants.listWhere({ subjectResource: who.resource, subjectId: who.id }))
    .slice()
    .sort((a, b) => String(a.grantedAt ?? '').localeCompare(String(b.grantedAt ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  if (rows.length === 0) {
    // The grant table was read completely and holds nothing for this
    // customer: a known zero, not an unknown.
    return Object.freeze({
      packageCreditsContract: PACKAGE_CREDITS_CONTRACT,
      available: true,
      subject: Object.freeze({ resource: who.resource, id: who.id }),
      granted: 0,
      consumed: 0,
      uncovered: 0,
      balance: 0,
      grants: Object.freeze([]),
      consumptionComplete: true,
      note: 'no package entries were ever granted to this customer — this is a read of the grant table, not an absence claim',
    });
  }
  const appointments = resolveCreditModule(context.modules, names.appointment)?.service ?? null;
  if (!appointments || typeof appointments.listWhere !== 'function') {
    return Object.freeze({
      packageCreditsContract: PACKAGE_CREDITS_CONTRACT,
      available: false,
      subject: Object.freeze({ resource: who.resource, id: who.id }),
      granted: rows.reduce((sum, row) => sum + row.totalEntries, 0),
      consumed: null,
      uncovered: null,
      balance: null,
      grants: Object.freeze([]),
      consumptionComplete: false,
      note: 'package entries were granted, but the appointments package is not composed here, so their consumption cannot be read '
        + '— this is not a claim the balance equals the granted count',
    });
  }
  const held = await appointments.listWhere({ subjectResource: who.resource, subjectId: who.id });
  // Our own rows, but the order is load-bearing for FIFO: a grant whose
  // instant cannot be proven refuses the balance rather than allocating
  // against a guess — the same fail-closed rule as for appointment rows.
  for (const row of rows) {
    if (!Number.isFinite(Date.parse(row.grantedAt))) {
      throw new AppError(
        `The package credit grant "${typeof row.id === 'string' && row.id !== '' ? row.id : 'unknown'}" carries no provable grant instant: `
          + 'the balance cannot order it against the appointments, so it is refused rather than guessed.',
        {
          code: 'COMMERCIAL_PACKAGE_CREDIT_UNPROVABLE',
          status: 500,
          details: { rowId: typeof row.id === 'string' ? row.id : null },
        },
      );
    }
  }
  const consuming = consumingAppointments(held);
  const { ledgers, uncovered } = allocateConsumption(rows, consuming);
  const detail = ledgers.map(({ grant, used }) => {
    const remaining = grant.totalEntries - used;
    return Object.freeze({
      id: grant.id,
      sourceKey: grant.sourceKey,
      productKey: grant.productKey,
      totalEntries: grant.totalEntries,
      used,
      // The floor lives here, per grant: only a grant carrying the explicit
      // `allowNegative` choice reports below zero.
      remaining: isTrue(grant.allowNegative) ? remaining : Math.max(0, remaining),
      allowNegative: isTrue(grant.allowNegative),
      noShowConsumes: isTrue(grant.noShowConsumes),
      grantedAt: grant.grantedAt,
    });
  });
  const consumed = detail.reduce((sum, grant) => sum + grant.used, 0);
  return Object.freeze({
    packageCreditsContract: PACKAGE_CREDITS_CONTRACT,
    available: true,
    subject: Object.freeze({ resource: who.resource, id: who.id }),
    granted: rows.reduce((sum, row) => sum + row.totalEntries, 0),
    consumed,
    uncovered,
    balance: detail.reduce((sum, grant) => sum + grant.remaining, 0),
    grants: Object.freeze(detail),
    consumptionComplete: true,
    note: 'a done appointment always consumes one entry; a no-show consumes one only on grants whose no-show rule says so; '
      + 'the balance never drops below zero except on grants carrying the explicit allow-negative choice',
  });
}

/**
 * `package-credits@1` — grant package entries and read the balance. It hands
 * out no service, no table and no query handle. Reads are exact: grants by
 * source key, one subject's rows by envelope, never a scan.
 *
 * @param {{moduleNames?: {credit?: string, appointment?: string}}} [options]
 */
export function createPackageCreditsCapability({ moduleNames } = {}) {
  const names = resolvedNames(moduleNames);
  const scoped = (context) => ({
    modules: {
      get: (name) => context.modules.get(
        name === PACKAGE_CREDIT_MODULE ? names.credit : name === 'appointment' ? names.appointment : name,
      ),
    },
    moduleNames: { credit: names.credit, appointment: names.appointment },
    actor: context.actor,
    now: context.now,
    consumer: context.consumer,
  });
  return {
    name: 'package-credits',
    version: 1,
    description:
      'Grant one paid package of entries per call, idempotent by the payment source key, and read one customer\'s '
      + 'balance from the stored appointment rows: done consumes one entry, no-show only where the grant\'s rule says so, '
      + 'and the floor holds at zero without the explicit allow-negative choice. No update and no delete.',
    /** @param {{modules: any, actor?: unknown, now?: () => string}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('package-credits@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const scope = scoped(context);
      return Object.freeze({
        capabilityContract: 1,
        /** @param {unknown} request */
        grantPackageEntries: (request) => grantPackageEntries(scope, request),
        /** @param {unknown} subject */
        packageBalance: (subject) => readPackageBalance(scope, subject),
      });
    },
  };
}
