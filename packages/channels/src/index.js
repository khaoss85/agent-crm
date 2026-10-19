// @ts-check

import { AppError, ValidationError, definePackage, selectPackageGraph } from '../../core/index.js';
import { CHANNELS, ChannelRegistries } from './adapter.js';
import { CONNECTION_STATUSES, assertConnectionTransition, assertSecretReference } from './connection.js';
import { createChannelOperations } from './operations.js';

/**
 * The Channels domain package (backlog:e5532d1c9146).
 *
 * The shared, space-scoped foundation every messaging channel builds on:
 * one connection record per space (channel, account, status, secret
 * reference), verified per-space inbound webhooks (signature, dedup,
 * quarantine), outbound sends through the durable-jobs outbox (bounded
 * retries, dead-letter queue), and the contract-test kit every adapter —
 * fixture today, real providers tomorrow — must pass.
 *
 * It reuses and never duplicates: durable jobs/outbox (spine v3), the M11
 * inbox shape (verify → DB-unique inbox → quarantine), ADR-015
 * fingerprints, and the module factory for its records. It changes no
 * kernel file (ADR-018): secret custody stays a deployment-injected edge.
 */

export const CHANNELS_PACKAGE = 'channels';

/** The record modules this package owns; declaring them makes a collision detectable. */
export const CHANNELS_RESOURCES = Object.freeze([
  'channel-connection', 'channel-inbox-event', 'channel-dead-letter', 'channel-import-state',
  'channel-import-outcome',
]);

function boundedReason(input, action) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason === '' || reason.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new ValidationError('reason must be bounded single-line text (1-300 characters)', { field: 'reason' });
  }
  return reason;
}

function requireUserActor(actor, action) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError(`${action} requires a human user actor`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return actor;
}

function statusAction(name, label, description, fromStates, toState, extra = {}) {
  return {
    module: 'channel-connection',
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
 * Open the sender reconciliation for one runtime from the composed
 * `channel-sender@1` capability published by the customer-data
 * definition, or null when the composition runs standalone. Opened once
 * per runtime with the caller's modules — the provider's names and the
 * caller's transaction. Webhook ingest and sends never resolve senders,
 * so a null here changes nothing until an import advances, which then
 * stores conversations and messages and leaves senders pending.
 */
function openSenderResolution(channelSender, runtime) {
  if (channelSender === undefined || channelSender === null) return null;
  if (typeof channelSender.create !== 'function') {
    throw new AppError(
      'The channels package needs the customer-data package capability channel-sender@1: '
      + 'compose it with the provider definition, e.g. createChannelsPackage({ customerData }) '
      + 'beside createCustomerDataPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
  const opened = channelSender.create({
    modules: runtime.modules,
    core: runtime.core,
    database: runtime.database,
    events: runtime.events,
    consumer: CHANNELS_PACKAGE,
  });
  if (!opened || typeof opened.resolveSender !== 'function') {
    throw new AppError(
      'The channels package needs the customer-data package capability channel-sender@1: '
      + 'the created capability opens no resolveSender',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
  return opened.resolveSender;
}

/** @param {Record<string, string>} [config] */
export function buildChannelConnectionActions(config = {}) {
  void config;
  return [
    statusAction(
      'activate-connection', 'Activate connection',
      'Activate a pending or suspended channel connection: sends and inbound application resume.',
      ['pending', 'suspended'], 'active',
    ),
    statusAction(
      'suspend-connection', 'Suspend connection',
      'Suspend a channel connection: sends refuse and inbound deliveries quarantine until reinstatement.',
      ['pending', 'active'], 'suspended',
    ),
    statusAction(
      'revoke-connection', 'Revoke connection',
      'Revoke a channel connection permanently. Terminal: a revoked binding never reactivates — register a new one.',
      ['pending', 'active', 'suspended'], 'revoked', { confirm: true },
    ),
    {
      module: 'channel-connection',
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
        const secretRef = assertSecretReference(typeof input?.secretRef === 'string' ? input.secretRef.trim() : '');
        const updated = await managed(record.id, { secretRef, secretRotatedAt: now() });
        return { connection: { id: updated.id, secretRef: updated.secretRef, secretRotatedAt: updated.secretRotatedAt } };
      },
    },
  ];
}

/**
 * Build the package definition the application composes.
 *
 * @param {{
 *   channelAdapters?: any[],
 *   resolveSecret?: (reference: string, context: {spaceId: string, purpose: string}) => Promise<string>,
 *   tenantId?: string,
 *   config?: Record<string, any>,
 *   modules?: Record<string, string>,
 *   customerData?: { capabilities?: Array<any> },
 * }} [options] `resolveSecret` is the deployment's custody edge; `tenantId`
 *   namespaces the jobs table inside the bound instance. Both are required
 *   because a package that sends without them would invent custody.
 *   `customerData` is the composed customer-data package definition — the
 *   same object the composition lists beside this package. The channels
 *   package takes the created `channel-sender@1` capability object from it,
 *   so sender reconciliation always runs with the provider's own name
 *   resolution and never with a second resolution from this package's
 *   options. Without it the initial history import still stores
 *   conversations and messages and leaves senders pending, while webhooks
 *   and sends work standalone as before.
 */
export function createChannelsPackage(options = {}) {
  const registries = new ChannelRegistries({ channelAdapters: options.channelAdapters ?? [] });
  // Custody and tenancy are deployment-owned and optional at composition so
  // validation and conformance compose empty; every secret resolution and
  // every send refuses until they are wired (fail-closed, never invented).
  const { resolveSecret, tenantId } = options;
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('channel resolveSecret must be a function', { field: 'resolveSecret' });
  }
  if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.trim() === '')) {
    throw new ValidationError('channel tenantId must be bounded text', { field: 'tenantId' });
  }
  const config = options.config ?? {};

  // The offered capability object, created once by the provider factory
  // with the provider's config. Held here by reference — never
  // re-instantiated, so a remapped customer-data composition cannot leave
  // the import writing the wrong tables while customer-data itself works.
  // The same handover shape appointments uses for work's `follow-up@1`.
  const offered = Array.isArray(options.customerData?.capabilities)
    ? options.customerData.capabilities.find((entry) => entry?.name === 'channel-sender' && entry?.version === 1) ?? null
    : null;

  // One composed instance PER APPLICATION runtime: operations close over
  // the registries and custody edge, and over the runtime's own database
  // and modules — the same per-runtime pattern the signature operations use,
  // so one composition module may serve several instances in one process.
  const composedByRuntime = new WeakMap();
  const operations = (runtime) => {
    let composed = composedByRuntime.get(runtime);
    if (!composed) {
      composed = createChannelOperations({
        database: runtime.database,
        modules: runtime.modules,
        registries,
        resolveSecret,
        tenantId,
        config,
        resolveSender: openSenderResolution(offered, runtime),
      });
      composedByRuntime.set(runtime, composed);
    }
    return composed;
  };

  const pkg = definePackage({
    packageContract: 1,
    name: CHANNELS_PACKAGE,
    version: 1,
    label: 'Channels',
    description: 'Space-scoped messaging-channel bindings: one connection record per space, verified replay-proof inbound webhooks with quarantine, outbound sends through the durable-jobs outbox with retries and a dead-letter queue with human requeue, the progressive initial history import for adapters with readable past, and the adapter contract-test kit.',
    resources: [...CHANNELS_RESOURCES],

    // No declared reach into another package: the sender reconciliation the
    // import writes through arrives as the handed-over `channel-sender@1`
    // capability object when customer-data is composed beside channels, and
    // the import leaves senders pending otherwise. A standalone composition
    // boots, receives webhooks, sends, and imports exactly as before —
    // never a missing-package refusal at boot, never a new requirement.
    // Everything (inbox, outbox, connections, import state and outcomes)
    // stays inside this package.

    actions: buildChannelConnectionActions(options.modules),
    operations: [
      {
        operationContract: 1,
        name: 'register-channel-connection',
        label: 'Register channel connection',
        appMethod: 'registerChannelConnection',
        description: 'Bind one channel account to one space under a named adapter version and a secret reference (human decision). A repeated registration resolves identically; a conflicting rebinding is refused.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug — always explicit, never inferred.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.registerChannelConnection(params);
        },
      },
      {
        operationContract: 1,
        name: 'ingest-channel-event',
        label: 'Ingest channel event',
        appMethod: 'ingestChannelEvent',
        description: 'Verify one channel webhook delivery as the exact bytes the provider signed, record it in the append-only replay-proof inbox — one row per provider item in the delivery — and apply it unless it is a replay, out-of-order or quarantined.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug, from the verified route — never from the body.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The connection source key bound to that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.ingestChannelEvent(params);
        },
      },
      {
        operationContract: 1,
        name: 'queue-channel-send',
        label: 'Queue channel send',
        appMethod: 'queueChannelSend',
        description: 'Queue one outbound channel message through the durable-jobs outbox under a deterministic idempotency key (human decision). Bounded retries; exhaustion lands in the dead-letter queue.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The active connection source key in that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.queueChannelSend(params);
        },
      },
      {
        operationContract: 1,
        name: 'start-initial-import',
        label: 'Start initial history import',
        appMethod: 'startInitialImport',
        description: 'Start the progressive initial import of one connection\'s provider past (a human decision). Records the window and the resume cursor; pulling starts with the first advance call.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The active connection source key in that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.startInitialImport(params);
        },
      },
      {
        operationContract: 1,
        name: 'advance-initial-import',
        label: 'Advance initial history import',
        appMethod: 'advanceInitialImport',
        description: 'Pull one bounded history page, store one inbox row per event through the deduped webhook path, and reconcile every imported sender to its contact — pending without the composed capability. Repeat until done.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The active connection source key in that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.advanceInitialImport(params);
        },
      },
      {
        operationContract: 1,
        name: 'read-initial-import',
        label: 'Read initial history import progress',
        appMethod: 'readInitialImport',
        description: 'Read the import progress of one connection: status and counts. Null when no import ever started.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'connectionKey', type: 'string', required: true, hint: 'The connection source key in that space.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.readInitialImport(params);
        },
      },
      {
        operationContract: 1,
        name: 'read-sync-state',
        label: 'Read space sync state',
        appMethod: 'readSyncState',
        description: 'Read the sync state of every connection in one space: one entry per connection with its first-import progress, plus the connected/completed totals over active connections whose adapter keeps a readable history (importable). A connection whose import never started reads sync null.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.readSyncState(params);
        },
      },
      {
        operationContract: 1,
        name: 'requeue-channel-letter',
        label: 'Requeue dead letter',
        appMethod: 'requeueChannelLetter',
        description: 'Retry one open dead letter with a human-supplied message: the letter carries no payload by design, so retrying means approving the content again. Concurrent retries serialize on the letter state: one wins and queues the send, the other is refused without touching the winner\'s job.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The Accordo space slug.' },
          { name: 'letterId', type: 'string', required: true, hint: 'The open dead-letter id.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.requeueChannelLetter(params);
        },
      },
    ],
    /** Function-free, additive schema metadata — never a secret, never a function. */
    metadata() {
      return {
        channelsContract: 1,
        channels: [...CHANNELS],
        connectionStatuses: [...CONNECTION_STATUSES],
        replayScope: 'space + connection + providerEventId; the payload fingerprint must match or the reuse is refused 409 CHANNEL_EVENT_ID_CONFLICT',
        sendRetry: 'bounded attempts on the durable job (default 5); transient failures ride the worker backoff; exhaustion writes a dead-letter row with phase, error code and payload fingerprint',
        secretDiscipline: 'connections store secretRef, never the secret; the deployment resolves it at call time; outbox payloads carry no secret-shaped keys',
        initialImport: 'one bounded history page per advance call through the deduped inbox path; every event writes one channel-import-outcome row and the progress counts those rows (one COUNT per state), never hand tallies; sender reconciliation arrives through the composed channel-sender@1 capability when present and stays pending otherwise; the cursor moves only on an owned transition',
        reuses: ['channel-sender@1'],
        humanApproval: 'register, status changes, sends and requeues require actor.type === "user"; provider-driven ingest runs under a system actor and ignores any caller-supplied actor',
        notModeled: [
          'real provider adapters beyond WhatsApp (Instagram, Gmail, …) — fixture only until credentials exist',
          'the per-space HTTP route — the pilot owns it and passes spaceId from the verified path',
          'secret custody and rotation flow — the deployment owns it via resolveSecret',
          'reconciliation against provider truth — redelivery resumes unprocessed rows',
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

export { ChannelRegistries } from './adapter.js';
export {
  assertHistoryPage,
  CHANNEL_HISTORY_PAGE_MAX,
  CHANNEL_HISTORY_TOKEN_MAX,
  CHANNEL_HISTORY_WINDOW_MAX_MS,
  validateChannelAdapter,
} from './adapter.js';
export { createChannelOperations } from './operations.js';
export { runChannelAdapterKit, CHANNEL_KIT_CHECKS } from './kit.js';
export { createFixtureChannelAdapter, fixtureWebhookHeaders, fixtureEventBody } from './fixture.js';
export {
  createInstagramChannelAdapter,
  instagramEventBody,
  instagramWebhookHeaders,
  INSTAGRAM_ADAPTER_NAME,
  INSTAGRAM_ADAPTER_VERSION,
  INSTAGRAM_HUMAN_AGENT_TAG,
  INSTAGRAM_REPLY_WINDOW_MS,
  INSTAGRAM_TAG_WINDOW_MS,
} from './instagram.js';
export {
  WHATSAPP_ADAPTER_NAME,
  WHATSAPP_ADAPTER_VERSION,
  WHATSAPP_WINDOW_MS,
  buildWhatsAppSendRequest,
  canonicalWhatsAppNumber,
  createWhatsAppChannelAdapter,
} from './whatsapp.js';
export {
  META_CUSTOMER_SERVICE_WINDOW_MS,
  checkMetaServiceWindow,
  isMetaSelfEcho,
  iterateMetaBatchItems,
  parseMetaWebhookBody,
} from './meta-webhook.js';
export {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  GMAIL_HISTORY_WINDOW_MS,
  GMAIL_MAX_TEXT,
  GMAIL_SUBJECT_PREFIX,
  buildGmailSendRequest,
  canonicalGmailAddress,
  createGmailChannelAdapter,
  gmailPushBody,
  gmailThreadIdForSubject,
  gmailThreadSubject,
} from './gmail.js';
export { verifyHmacWebhook, fingerprintPayload, hmacWebhookHeaders } from './crypto.js';
