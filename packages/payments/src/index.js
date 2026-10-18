// @ts-check

import { AppError, ValidationError, definePackage, selectPackageGraph } from '../../core/index.js';
import { PAYMENT_PROVIDERS, PaymentRegistries } from './adapter.js';
import { CONNECTION_STATUSES, assertConnectionTransition, assertSecretReference } from './connection.js';
import { createPaymentOperations } from './operations.js';
import { advancePaymentRequest } from './transitions.js';

/**
 * The Payments domain package (backlog:1972e16d33f2).
 *
 * Stripe payments for commercial packages: one connection record per space
 * (provider, account, status, secret reference), payment requests from a
 * quote or an offer (intent → provider checkout or payment link → pending),
 * verified replay-proof inbound webhooks that finalize each request exactly
 * once, and the status reads the customer card and the sales pipeline
 * render. No invoices: the request record is the payment, never a fiscal
 * document.
 *
 * It reuses and never duplicates: the M11 inbox shape (verify → DB-unique
 * inbox → quarantine, the same shape the channels package proves), ADR-015
 * fingerprints, ADR-014 integer-minor-unit money, and the module factory
 * for its records. It changes no kernel file (ADR-018): secret custody
 * stays a deployment-injected edge.
 */

export const PAYMENTS_PACKAGE = 'payments';

/** The record modules this package owns; declaring them makes a collision detectable. */
export const PAYMENTS_RESOURCES = Object.freeze([
  'payment-connection', 'payment-request', 'payment-event',
]);

function boundedReason(input, action) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason === '' || reason.length > 300 || hasControlChar(reason)) {
    throw new ValidationError('reason must be bounded single-line text (1-300 characters)', { field: 'reason' });
  }
  return reason;
}

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireUserActor(actor, action) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError(`${action} requires a human user actor`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return actor;
}

function statusAction(moduleName, name, label, description, fromStates, toState, extra = {}) {
  return {
    module: moduleName,
    name,
    label,
    description,
    actionContract: 1,
    stateField: 'status',
    fromStates,
    ...extra,
    input: [
      { name: 'reason', type: 'string', required: true, hint: 'Why this transition — a status change without a reason is evidence nobody can check.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, managed }) {
      const who = requireUserActor(actor, label);
      void who;
      const reason = boundedReason(input, name);
      assertConnectionTransition(record.status, toState);
      const updated = await managed(record.id, { status: toState, statusReason: reason });
      return { connection: { id: updated.id, status: updated.status } };
    },
  };
}

/**
 * Resolve the record-module names this package writes. `modules` maps the
 * canonical record names (`payment-connection`, `payment-request`,
 * `payment-event`) to the composed module names; the `connectionModule`
 * family of config keys says the same thing the long way. Both are honored;
 * anything else is refused, never silently ignored.
 */
export function resolvePaymentModuleNames({ config = {}, modules = null } = {}) {
  const names = {
    'payment-connection': 'payment-connection',
    'payment-request': 'payment-request',
    'payment-event': 'payment-event',
  };
  const fromConfig = {
    'payment-connection': config.connectionModule,
    'payment-request': config.requestModule,
    'payment-event': config.eventModule,
  };
  for (const [key, value] of Object.entries(fromConfig)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value === '') {
      throw new ValidationError(`payment module name for "${key}" must be a non-empty string`, { field: 'modules' });
    }
    names[key] = value;
  }
  if (modules !== undefined && modules !== null) {
    if (!modules || typeof modules !== 'object' || Array.isArray(modules)) {
      throw new ValidationError('payment modules must map record names to module names', { field: 'modules' });
    }
    for (const [key, value] of Object.entries(modules)) {
      if (!Object.hasOwn(names, key)) {
        throw new ValidationError(`unknown payment module "${key}": expected one of ${Object.keys(names).join(', ')}`, { field: 'modules' });
      }
      if (typeof value !== 'string' || value === '') {
        throw new ValidationError(`payment module name for "${key}" must be a non-empty string`, { field: 'modules' });
      }
      names[key] = value;
    }
  }
  return Object.freeze({ ...names });
}

/**
 * The stores the cancel-request action moves through. The framework runs
 * the action inside its own transaction with a freshly re-read record and
 * hands over services, modules and database; a minimal direct-execute
 * caller passes only the record under test plus `managed`, and the table
 * still guards the move.
 */
function cancelStores(names, { record, managed, modules, database }) {
  const serviceFor = (name) => {
    try {
      return modules?.get?.(name)?.service ?? null;
    } catch {
      return null;
    }
  };
  const requests = serviceFor(names['payment-request']);
  const connections = serviceFor(names['payment-connection']);
  if (requests && connections
    && typeof requests.get === 'function' && typeof requests.applyManaged === 'function'
    && typeof connections.listWhere === 'function') {
    return { requests, connections, database: database ?? requests.database ?? null };
  }
  return {
    requests: {
      get: async (id) => {
        if (id !== record.id) {
          throw new AppError('Unknown payment request', { code: 'PAYMENT_REQUEST_UNKNOWN', status: 404 });
        }
        return record;
      },
      applyManaged: managed,
      database: null,
    },
    connections: { listWhere: () => [] },
    database: null,
  };
}

/**
 * @param {Record<string, string>} [names] resolved record-module names
 * (`resolvePaymentModuleNames`); defaults to the canonical names.
 */
export function buildPaymentConnectionActions(names = {}) {
  const moduleName = (canonical) => (
    typeof names[canonical] === 'string' && names[canonical] !== '' ? names[canonical] : canonical
  );
  const connectionModule = moduleName('payment-connection');
  const requestModule = moduleName('payment-request');
  const resolved = {
    'payment-connection': connectionModule,
    'payment-request': requestModule,
    'payment-event': moduleName('payment-event'),
  };
  return [
    statusAction(
      connectionModule,
      'activate-connection', 'Activate connection',
      'Activate a pending or suspended payment connection: requests and inbound finalization resume.',
      ['pending', 'suspended'], 'active',
    ),
    statusAction(
      connectionModule,
      'suspend-connection', 'Suspend connection',
      'Suspend a payment connection: requests refuse and inbound deliveries quarantine until reinstatement.',
      ['pending', 'active'], 'suspended',
    ),
    statusAction(
      connectionModule,
      'revoke-connection', 'Revoke connection',
      'Revoke a payment connection: requests refuse and inbound deliveries quarantine. A revoked binding returns only through the explicit rebind-connection action — registering the same account again is refused.',
      ['pending', 'active', 'suspended'], 'revoked', { confirm: true },
    ),
    {
      module: connectionModule,
      name: 'rotate-connection-secret',
      label: 'Rotate connection secret',
      description: 'Point a connection at a new secret reference and stamp the rotation time. The value is never stored — rotation replaces the referenced value without touching CRM data.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['pending', 'active', 'suspended'],
      input: [
        { name: 'secretRef', type: 'string', required: true, hint: 'The new secret reference locator — never a secret value.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, actor, managed, now }) {
        requireUserActor(actor, 'Rotate connection secret');
        // fromStates is a framework routing hint, not an enforcement: a
        // direct execute on a revoked binding is refused here, like the
        // table-guarded status moves above. A revoked binding rebinds
        // instead of rotating.
        if (!['pending', 'active', 'suspended'].includes(record.status)) {
          throw new AppError('Rotate connection secret needs a live connection: a revoked binding rebinds instead', {
            code: 'PAYMENT_ROTATE_INVALID', status: 409,
          });
        }
        const secretRef = assertSecretReference(typeof input?.secretRef === 'string' ? input.secretRef.trim() : '');
        const updated = await managed(record.id, { secretRef, secretRotatedAt: now() });
        return { connection: { id: updated.id, secretRef: updated.secretRef, secretRotatedAt: updated.secretRotatedAt } };
      },
    },
    {
      module: connectionModule,
      name: 'rebind-connection',
      label: 'Rebind connection',
      description: 'Rebind a revoked connection to a new secret reference and return it to pending: the explicit incident-recovery path for a revoked account. The binding serves traffic only after activate-connection runs.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['revoked'],
      input: [
        { name: 'secretRef', type: 'string', required: true, hint: 'The new secret reference locator — never a secret value.' },
        { name: 'reason', type: 'string', required: true, hint: 'Why this revoked binding is rebound.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, actor, managed, now }) {
        const who = requireUserActor(actor, 'Rebind connection');
        void who;
        const reason = boundedReason(input, 'rebind-connection');
        const secretRef = assertSecretReference(typeof input?.secretRef === 'string' ? input.secretRef.trim() : '');
        // The single documented exception to revoked-terminal: the table
        // owns the move, so a direct execute on a live binding is refused
        // here exactly like the status moves above.
        assertConnectionTransition(record.status, 'pending');
        const updated = await managed(record.id, {
          status: 'pending', statusReason: reason, secretRef, secretRotatedAt: now(),
        });
        return { connection: { id: updated.id, status: updated.status, secretRef: updated.secretRef } };
      },
    },
    {
      module: requestModule,
      name: 'cancel-request',
      label: 'Cancel payment request',
      description: 'Cancel an open or pending payment request. A paid or failed request never regresses: canceling it is refused.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['open', 'pending'],
      input: [
        { name: 'reason', type: 'string', required: true, hint: 'Why this request is canceled.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, actor, managed, modules, database }) {
        const who = requireUserActor(actor, 'Cancel payment request');
        const reason = boundedReason(input, 'cancel-request');
        // Cancel moves through the same single state path as mint and
        // ingest: the table owns the move, so a direct execute on a paid,
        // failed or canceled request is refused instead of regressing it.
        const { request } = await advancePaymentRequest(
          cancelStores(resolved, { record, managed, modules, database }),
          record.id,
          { event: 'cancel', patch: { statusReason: reason }, actor: who },
        );
        return { request: { id: request.id, status: request.status } };
      },
    },
  ];
}

/**
 * Build the package definition the application composes.
 *
 * @param {{
 *   paymentAdapters?: any[],
 *   resolveSecret?: (reference: string, context: {spaceId: string, purpose: string}) => Promise<string>,
 *   tenantId?: string,
 *   config?: Record<string, any>,
 *   modules?: Record<string, string>,
 * }} [options] `resolveSecret` is the deployment's custody edge; both it
 *   and the adapter list arrive from the composition. Custody is optional
 *   at composition so validation and conformance compose empty; every
 *   secret resolution refuses until it is wired (fail-closed, never
 *   invented).
 */
export function createPaymentsPackage(options = {}) {
  const registries = new PaymentRegistries({ paymentAdapters: options.paymentAdapters ?? [] });
  const { resolveSecret } = options;
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('payment resolveSecret must be a function', { field: 'resolveSecret' });
  }
  // The record-module names are resolved once, honored by both layers —
  // the actions declare them and the operations write through them — and
  // anything else in `modules` is refused, never silently ignored.
  const moduleNames = resolvePaymentModuleNames({ config: options.config ?? {}, modules: options.modules ?? null });
  const opsConfig = {
    ...(options.config ?? {}),
    connectionModule: moduleNames['payment-connection'],
    requestModule: moduleNames['payment-request'],
    eventModule: moduleNames['payment-event'],
  };

  // One composed instance PER APPLICATION runtime: operations close over
  // the registries and custody edge, and over the runtime's own database
  // and modules — the same per-runtime pattern the channels and signature
  // operations use, so one composition module may serve several instances
  // in one process.
  const composedByRuntime = new WeakMap();
  const operations = (runtime) => {
    let composed = composedByRuntime.get(runtime);
    if (!composed) {
      composed = createPaymentOperations({
        database: runtime.database,
        modules: runtime.modules,
        registries,
        resolveSecret,
        config: opsConfig,
      });
      composedByRuntime.set(runtime, composed);
    }
    return composed;
  };

  const pkg = definePackage({
    packageContract: 1,
    name: PAYMENTS_PACKAGE,
    version: 1,
    label: 'Payments',
    description: 'Space-scoped Stripe payment bindings: one connection record per space (provider, account, status, secret reference), payment requests from a quote or an offer (intent, provider checkout, verified once-only finalization), and the status reads the card and the pipeline render.',
    resources: [...PAYMENTS_RESOURCES],
    actions: buildPaymentConnectionActions(moduleNames),
    operations: [
      {
        operationContract: 1,
        name: 'register-payment-connection',
        label: 'Register payment connection',
        appMethod: 'registerPaymentConnection',
        description: 'Bind one payment provider account to one space under a named adapter version and a secret reference (human decision). A repeated registration resolves identically; a conflicting rebinding is refused.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.registerPaymentConnection(params);
        },
      },
      {
        operationContract: 1,
        name: 'request-payment',
        label: 'Request payment',
        appMethod: 'requestPayment',
        description: 'Request a payment from exactly one of a quote or an offer: records the intent, mints the provider checkout under a deterministic intent key (a retried request resolves to the same checkout), and leaves it pending for webhook finalization (human decision).',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The active connection source key in that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.requestPayment(params);
        },
      },
      {
        operationContract: 1,
        name: 'ingest-payment-event',
        label: 'Ingest payment event',
        appMethod: 'ingestPaymentEvent',
        description: 'Verify one payment webhook delivery as the exact bytes the provider signed and finalize the matching request exactly once: a replay resolves identically, a contradicting event against a terminal request quarantines, and the stored outcome always wins.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug, from the verified route — never from the body.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The connection source key bound to that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.ingestPaymentEvent(params);
        },
      },
      {
        operationContract: 1,
        name: 'get-payment-status',
        label: 'Get payment status',
        appMethod: 'getPaymentStatus',
        description: 'Read one payment request status for the customer card and the sales pipeline: function-free data, never a secret.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.getPaymentStatus(params?.spaceId, params?.requestId);
        },
      },
      {
        operationContract: 1,
        name: 'list-payments',
        label: 'List payments',
        appMethod: 'listPayments',
        description: 'List the payment requests of one space for the sales pipeline: function-free data, never a secret. An unknown status filter is refused, never an empty list.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'status', type: 'string', required: false, hint: 'Optional request status filter.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          // Thin pass-through: the filter refusal lives in ops.listPayments
          // itself. Async so it rejects the returned promise like every
          // other operation outcome, never throws synchronously.
          return async (params) => ops.listPayments(params?.spaceId, { status: params?.status ?? null });
        },
      },
    ],
    /** Function-free, additive schema metadata — never a secret, never a function. */
    metadata() {
      return {
        paymentsContract: 1,
        providers: [...PAYMENT_PROVIDERS],
        connectionStatuses: [...CONNECTION_STATUSES],
        lifecycle: 'open (intent) -> pending (checkout minted) -> paid | failed; open | pending -> canceled; terminal states never regress',
        replayScope: 'space + connection + providerEventId; the payload fingerprint must match or the reuse is refused 409 PAYMENT_EVENT_ID_CONFLICT',
        secretDiscipline: 'connections store secretRef, never the secret; the deployment resolves it at call time; minted provider values are refused when secret-shaped',
        humanApproval: 'register, status changes, requests and cancels require actor.type === "user"; provider-driven ingest runs under a system actor and ignores any caller-supplied actor',
        notModeled: [
          'invoices — deliberately absent: the request record is the payment, never a fiscal document',
          'card and pipeline rendering — they read getPaymentStatus; the rendering itself is a follow-up voice',
          'real Stripe adapter beyond the fixture — fixture only until credentials exist',
          'the per-space HTTP route — the pilot owns it and passes spaceId from the verified path',
          'secret custody and rotation flow — the deployment owns it via resolveSecret',
          'reconciliation against provider truth — redelivery resumes unprocessed outcomes',
          'retry of a failed request — a failed intent is terminal; a new requestKey starts a new intent',
        ],
      };
    },
  });

  /**
   * Adapter fingerprints persist exactly where every other declared
   * definition's do — the package definition-version store — so a moved
   * adapter source stops the boot like any other drift (ADR-015).
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);

  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return selectPackageGraph(pkg, 1);
}

export { PaymentRegistries } from './adapter.js';
export { validatePaymentAdapter } from './adapter.js';
export { createPaymentOperations } from './operations.js';
export { createFixtureStripeAdapter, fixturePaymentWebhookHeaders, fixturePaymentEventBody } from './stripe.js';
export {
  verifyPaymentWebhook, fingerprintPayload, paymentWebhookHeaders,
} from './crypto.js';
