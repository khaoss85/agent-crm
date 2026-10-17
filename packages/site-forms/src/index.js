// @ts-check

import {
  AppError,
  ConflictError,
  definePackage,
  NotFoundError,
  nowIso,
  selectPackageGraph,
  ValidationError,
} from '../../core/index.js';
import {
  MIN_DWELL_MS,
  RATE_MAX_PER_WINDOW,
  RATE_READ_CAP,
  RATE_WINDOW_MS,
  REASON,
  SITE_FORMS_PACKAGE,
  buildSnippet,
  evaluateSpam,
  replyChannels,
  submissionSourceKey,
  validateFormFields,
} from './rules.js';

/**
 * The Site Forms domain package (backlog:9d42035eca26).
 *
 * The website-form intake for one Accordo space: a visitor fills the snippet
 * pasted into the site, the pilot resolves the sender through customer-data,
 * and this package turns the request into an inbound `website-form` message
 * on the contact's conversation — the card update the team answers from.
 *
 * It reuses and never duplicates: sender resolution and external-identity
 * provenance (`customer-data` operation `resolveChannelSender`, run by the
 * pilot before the submission is opened), the inbound message and
 * conversation records (`interactions/interaction-log@1`), the host contact
 * record, and the module factory for its own evidence rows. It changes no
 * kernel file (ADR-018).
 *
 * What is deliberately NOT here: the per-space HTTP route and the sender
 * orchestration (the pilot owns them, like every channel adapter route),
 * secret custody, provider sends, and paid anti-spam services.
 */

export const SITE_FORMS_DOMAIN = SITE_FORMS_PACKAGE;

/** The records this package owns. No other package holds form submissions. */
export const SITE_FORMS_RESOURCES = Object.freeze(['site-form-submission']);

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    submission: config.submissionModule ?? 'site-form-submission',
    contact: config.contactModule ?? 'contact',
  };
}

/** A uniqueness conflict means a concurrent open won the race: re-read and replay the winner. */
function isWinnerConflict(error) {
  if (error instanceof ConflictError) return true;
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'SITE_FORMS_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * Open the interaction-log capability this action was composed with. Without
 * the declared requirement the action refuses instead of logging halfway.
 */
function interactionLog({ domains, modules, actor, now }) {
  if (!domains || typeof domains.capability !== 'function') {
    throw new AppError('Site-form intake needs the package registry to log its message', {
      code: 'SITE_FORMS_REGISTRY_UNAVAILABLE', status: 500,
    });
  }
  try {
    return domains.capability({
      consumer: SITE_FORMS_PACKAGE,
      capability: 'interaction-log',
      version: 1,
      context: { modules, actor, now },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      'The site-forms package requires the interactions package capability interaction-log@1, which is not available',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/**
 * Read this submitter's recent submission timestamps for the rate window.
 * Fail-closed past the read cap: the window read is itself the flood then.
 */
async function recentSubmitterRows(service, { spaceId, ipHash }, excludeId = null) {
  const count = await service.countWhere({ spaceId, ipHash });
  if (count >= RATE_READ_CAP) return { capped: true, atMs: [] };
  const rows = await service.listWhere({ spaceId, ipHash });
  const atMs = [];
  for (const row of rows) {
    if (excludeId !== null && row.id === excludeId) continue;
    const at = Date.parse(row.occurredAt);
    if (!Number.isNaN(at)) atMs.push(at);
  }
  atMs.sort((left, right) => left - right);
  return { capped: false, atMs };
}

/** The one declared reach into other packages. Without it the package refuses to register. */
const SITE_FORMS_REQUIRES = Object.freeze([
  { package: 'interactions', capability: 'interaction-log', version: 1 },
]);

/** @param {Record<string, string>} [config] */
export function buildSiteFormsActions(config = {}) {
  const names = resolvedNames(config);
  return [
    {
      module: 'site-form-submission',
      name: 'submit',
      label: 'Process a site-form submission',
      description:
        'Gate one pending website-form submission through base anti-spam, attach it to the resolved contact as an '
        + 'inbound website-form message, and record the reply channels. A sender the pilot could not resolve is '
        + 'kept as needs-review: evidence for a human, never a message from nobody.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['pending'],
      input: [
        { name: 'subjectResource', type: 'string', required: false, hint: 'The resolved subject resource — contact. Omit when the sender is unresolved.' },
        { name: 'subjectId', type: 'string', required: false, hint: 'The resolved subject id. Omit when the sender is unresolved.' },
        { name: 'senderOutcome', type: 'enum', values: ['matched', 'created', 'unresolved'], required: true, hint: 'The customer-data sender resolution outcome the pilot ran before opening this submission.' },
        { name: 'senderRule', type: 'string', required: true, hint: 'The rule that resolved the sender, for the receipt.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, actor, modules, domains, managed, now }) {
        const submissions = trusted(modules, names.submission);
        const senderOutcome = input.senderOutcome;
        const senderRule = typeof input.senderRule === 'string' ? input.senderRule.slice(0, 128) : '';
        const decidedAt = now();

        // The row being submitted is not its own flood: the window counts the
        // submitter's *other* rows.
        const window = await recentSubmitterRows(
          submissions, { spaceId: record.spaceId, ipHash: record.ipHash }, record.id,
        );
        // A submitter past the read cap is flooding faster than the window
        // can count: the capped read refuses the same way.
        const verdict = window.capped
          ? { spam: true, reasonCode: REASON.RATE_LIMITED }
          : evaluateSpam(
            { honeypotFilled: record.honeypotFilled === true, dwellMs: record.dwellMs },
            window.atMs,
            Date.parse(decidedAt),
          );
        if (verdict.spam) {
          const updated = await managed(record.id, {
            status: 'rejected', reasonCode: /** @type {string} */ (verdict.reasonCode), decidedAt,
          });
          return {
            submission: {
              id: updated.id, status: updated.status, reasonCode: updated.reasonCode, replayed: false,
            },
          };
        }

        if (senderOutcome === 'unresolved') {
          const updated = await managed(record.id, {
            status: 'needs-review', reasonCode: REASON.NEEDS_REVIEW, decidedAt,
          });
          return {
            submission: {
              id: updated.id, status: updated.status, reasonCode: updated.reasonCode, replayed: false,
            },
          };
        }

        const subjectResource = typeof input.subjectResource === 'string' ? input.subjectResource : '';
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        if (subjectResource !== 'contact' || subjectId === '') {
          throw new ValidationError('a resolved submission names a contact subject', { field: 'subjectId' });
        }
        // The contact is a host record: prove it exists before evidence names
        // it, so a stale resolution fails here instead of orphaning a message.
        const contacts = modules.get(names.contact)?.service;
        if (!contacts || typeof contacts.get !== 'function') {
          throw new AppError(`Module "${names.contact}" is not available`, {
            code: 'SITE_FORMS_CONTACT_UNAVAILABLE', status: 500,
          });
        }
        try {
          await contacts.get(subjectId);
        } catch (error) {
          if (error instanceof NotFoundError) {
            throw new ValidationError('the resolved contact no longer exists', { field: 'subjectId' });
          }
          throw error;
        }

        const channels = replyChannels({ phone: record.phone ?? null, email: record.email ?? null });
        const log = interactionLog({ domains, modules, actor, now });
        const subject = { resource: 'contact', id: subjectId, owner: 'host' };
        const source = { package: SITE_FORMS_PACKAGE, action: 'submit' };
        const remoteHandle = record.phone ?? record.email ?? null;
        const conversationKey = `site-form:${record.spaceId}:${subjectId}`;
        const { conversation } = await log.openConversation({
          sourceKey: conversationKey,
          subject,
          channel: 'website-form',
          remoteHandle,
          source,
        });
        const { message } = await log.logMessage({
          sourceKey: `site-form-message:${record.id}`,
          conversationId: conversation.id,
          direction: 'inbound',
          channel: 'website-form',
          body: record.body,
          remoteHandle,
          subject,
          occurredAt: record.occurredAt,
          source,
        });
        const updated = await managed(record.id, {
          status: 'accepted',
          subjectResource: 'contact',
          subjectId,
          conversationId: conversation.id,
          messageId: message.id,
          replyWhatsapp: channels.whatsapp,
          replyEmail: channels.email,
          reasonCode: `sender:${senderRule}`,
          decidedAt,
        });
        return {
          submission: {
            id: updated.id,
            status: updated.status,
            conversationId: updated.conversationId,
            messageId: updated.messageId,
            replyWhatsapp: updated.replyWhatsapp,
            replyEmail: updated.replyEmail,
            replayed: false,
          },
        };
      },
    },
  ];
}

/**
 * Build the package definition the application composes.
 * @param {{config?: Record<string, string>}} [options]
 */
export function createSiteFormsPackage(options = {}) {
  const config = options.config;
  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: SITE_FORMS_DOMAIN,
    version: 1,
    label: 'Website-form intake',
    description:
      'Website-form requests for one space: base anti-spam gating, one evidence row per request, the inbound '
      + 'website-form message on the resolved contact, the reply-channel rule, and the paste-into-the-site snippet.',
    resources: [...SITE_FORMS_RESOURCES],
    requires: [...SITE_FORMS_REQUIRES],
    actions: buildSiteFormsActions(config),
    operations: [
      {
        operationContract: 1,
        name: 'open-site-form-submission',
        label: 'Open a site-form submission',
        appMethod: 'openSiteFormSubmission',
        description:
          'Validate one website-form request and open its pending evidence row. Idempotent by the caller-supplied '
          + 'idempotency key: a retry replays the stored row. Spam is gated when the row is submitted, not here.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'idempotencyKey', type: 'string', hint: 'One form render, one key: a UUID the snippet generates per render.' },
        ],
        create(runtime) {
          const moduleNames = resolvedNames(runtime.config ?? {});
          return async (request) => {
            const fields = validateFormFields(request);
            const sourceKey = submissionSourceKey(fields.spaceId, request.idempotencyKey);
            const submissions = trusted(runtime.modules, moduleNames.submission);
            const existing = await submissions.listWhere({ sourceKey });
            if (existing[0]) return { submission: existing[0], replayed: true };
            const occurredAt = nowIso();
            let submission;
            try {
              submission = await submissions.createManaged({
                sourceKey,
                spaceId: fields.spaceId,
                status: 'pending',
                firstName: fields.firstName,
                lastName: fields.lastName,
                email: fields.email,
                phone: fields.phone,
                companyName: fields.companyName,
                body: fields.body,
                ipHash: fields.ipHash,
                honeypotFilled: fields.honeypotFilled,
                dwellMs: fields.dwellMs,
                subjectResource: null,
                subjectId: null,
                conversationId: null,
                messageId: null,
                replyWhatsapp: false,
                replyEmail: false,
                reasonCode: null,
                occurredAt,
                decidedAt: null,
              }, { actor: request.actor ?? { type: 'system', id: 'site-forms:intake' } });
            } catch (error) {
              if (!isWinnerConflict(error)) throw error;
              const raced = await submissions.listWhere({ sourceKey });
              if (!raced[0]) throw error;
              return { submission: raced[0], replayed: true };
            }
            return { submission, replayed: false };
          };
        },
      },
      {
        operationContract: 1,
        name: 'check-site-form',
        label: 'Pre-check a site-form request',
        appMethod: 'checkSiteForm',
        description:
          'Run the base anti-spam rules over one request before the pilot resolves its sender, so an obvious bot '
          + 'creates no contact. Reads only, writes nothing; the submit action re-gates authoritatively.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug.' },
          { name: 'ipHash', type: 'string', hint: 'The sha256 of the caller IP for this space — never the raw address.' },
          { name: 'honeypotFilled', type: 'json', hint: 'Whether the trap field arrived filled (JSON boolean).' },
          { name: 'dwellMs', type: 'integer', hint: 'Milliseconds between render and submit.' },
        ],
        create(runtime) {
          const moduleNames = resolvedNames(runtime.config ?? {});
          return async (request) => {
            const spaceId = typeof request.spaceId === 'string' ? request.spaceId : '';
            const ipHash = typeof request.ipHash === 'string' ? request.ipHash : '';
            const { atMs } = await recentSubmitterRows(trusted(runtime.modules, moduleNames.submission), {
              spaceId, ipHash,
            });
            const verdict = evaluateSpam({
              honeypotFilled: request.honeypotFilled === true,
              dwellMs: Number.isInteger(request.dwellMs) ? request.dwellMs : -1,
            }, atMs, Date.parse(nowIso()));
            if (verdict.spam) {
              throw new AppError('the form request looks automated and is refused', {
                code: /** @type {string} */ (verdict.reasonCode), status: 422,
              });
            }
            return { ok: true };
          };
        },
      },
      {
        operationContract: 1,
        name: 'site-form-snippet',
        label: 'Render the site-form snippet',
        appMethod: 'siteFormSnippet',
        description:
          'Render the dependency-free HTML form to paste into the website for one space. No tracker, no third '
          + 'party, no credential — the per-space endpoint is the whole config.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug.' },
          { name: 'endpoint', type: 'string', hint: 'The pilot base URL, e.g. https://app.accordo.dev.' },
        ],
        create() {
          return async (request) => buildSnippet({
            spaceId: request.spaceId, endpoint: request.endpoint, formId: request.formId,
          });
        },
      },
    ],
    /** Function-free, additive schema metadata — never a secret, never a function. */
    metadata() {
      return {
        siteFormsContract: 1,
        submissionStates: ['pending', 'accepted', 'rejected', 'needs-review'],
        spam: {
          honeypot: 'a filled trap field refuses the submission as SPAM_HONEYPOT',
          minDwellMs: MIN_DWELL_MS,
          rateWindow: `at most ${RATE_MAX_PER_WINDOW} submissions per space and submitter hash per ${RATE_WINDOW_MS / 1000} seconds, else SPAM_RATE_LIMITED`,
          noPaidService: 'no captcha, no scoring service, no third party sees the request',
        },
        replyRule: 'phone present answers on WhatsApp, email-only answers by email, both present answers on both',
        provenance: 'the contact and its channel identities are written only by customer-data sender resolution (runId channel-sender); this package records the subject, never the identity',
        replayScope: 'one idempotency key opens one submission; the same key replays the stored row, never a second one',
        pilotOwns: [
          'the per-space HTTP route (POST /site/:spaceId/submit), passing spaceId from the verified path',
          'resolving the sender with customer-data resolveChannelSender before opening the submission',
          'creating the submission and running its submit action in that order',
        ],
        notModeled: [
          'real provider sends (WhatsApp/email delivery) — the team answers from the card',
          'paid or third-party anti-spam (captcha, scoring)',
          'sender resolution — customer-data owns it; an unresolved sender stays needs-review',
          'multi-step or file-upload forms',
        ],
      };
    },
  }), 1);
}
