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
  'channel-connection', 'channel-inbox-event', 'channel-dead-letter',
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
 * }} [options] `resolveSecret` is the deployment's custody edge; `tenantId`
 *   namespaces the jobs table inside the bound instance. Both are required
 *   because a package that sends without them would invent custody.
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
    description: 'Space-scoped messaging-channel bindings: one connection record per space (channel, account, status, secret reference), verified replay-proof inbound webhooks with quarantine, outbound sends through the durable-jobs outbox with bounded retries and a dead-letter queue, and the adapter contract-test kit.',
    resources: [...CHANNELS_RESOURCES],
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
      // Dead-letter requeue is deferred to a follow-up voice with its own
      // state machine: this PR ships register / ingest / queue / dead-letter
      // inventory only.
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
        humanApproval: 'register, status changes and sends require actor.type === "user"; provider-driven ingest runs under a system actor and ignores any caller-supplied actor',
        notModeled: [
          'dead-letter requeue (human retry of an open letter) — follow-up voice with its own state machine',
          'real provider adapters beyond WhatsApp (Instagram, Gmail, …) — fixture only until credentials exist',
          'the per-space HTTP route — the pilot owns it and passes spaceId from the verified path',
          'secret custody and rotation flow — the deployment owns it via resolveSecret',
          'reconciliation against provider truth — redelivery resumes unprocessed rows',
          'per-connection observability aggregates',
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
export { validateChannelAdapter } from './adapter.js';
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
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
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
