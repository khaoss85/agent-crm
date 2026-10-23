// @ts-check

import {
  AppError,
  ValidationError,
  normalizeError,
  requireActor,
  withTimeout,
} from '../../core/index.js';
import { assertSpaceId } from './connection.js';
import { CHANNEL_SEND_TIMEOUT_MS, CHANNEL_SECRET_PURPOSE_OUTBOUND } from './operations.js';

/**
 * **Template-only sends — the seam automatic reminders call (backlog:fe0fe10b85d1).**
 *
 * An automatic reminder runs under the timer's system actor, never under the
 * human actor `queue-channel-send` demands — so this seam cannot be that
 * operation with a wider actor. What makes it safe instead is structural:
 * it sends **only** an adapter-normalized approved template and refuses
 * everything else before any secret is resolved and before any bytes leave.
 * An agent that can reach this seam can send the booking's own approved
 * reminder template to the booking's own recipient, and nothing else: no
 * free text, no unapproved template, no second recipient, no second channel.
 *
 * Custody stays where it is: the secret is resolved here at call time from
 * the deployment's resolver and never stored, never returned, never logged.
 * The provider send is synchronous with a bounded timeout; retries belong to
 * the caller (the reminder sweep job owns its attempts). Terminal failures
 * throw typed codes — the caller's follow-up stays open as the human
 * fallback, exactly like a queued send whose dead letter a human requeues.
 *
 * Every call carries its actor (`requireActor`, like the other write
 * capabilities): no anonymous sends. Automatic sends arrive under the
 * timer's system actor, human ones under their user actor.
 */

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,64}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2}(?:_[A-Z]{2})?$/;
const MAX_TEMPLATE_VARIABLES = 32;
const MAX_VARIABLE_CHARS = 1024;
const MAX_CONNECTION_KEY = 200;
const MAX_RECIPIENT = 64;
const PROVIDER_MESSAGE_ID_MAX = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function boundedLine(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL_RE.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line text (at most ${max} characters)`, { field });
  }
  return value;
}

/**
 * The recipient shape, mirrored from the WhatsApp adapter's own rule
 * (`packages/channels/src/whatsapp.js`): an E.164 number. The adapter
 * re-proves it strictly at send time; this is the fail-fast shape so a
 * booking names a number, never a handle, a group id or prose.
 */
function assertRecipient(value) {
  const to = boundedLine(value, 'to', MAX_RECIPIENT);
  if (!/^\+[0-9][0-9 .\-()/]{3,}$/.test(to)) {
    throw new ValidationError('to must be an E.164 number ("+" followed by digits)', { field: 'to' });
  }
  return to;
}

function assertTemplateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('template must be an object {name, language?, variables?}', { field: 'template' });
  }
  const name = typeof value.name === 'string' ? value.name : '';
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new ValidationError('template.name must be a Meta template name (lowercase letters, digits, underscores)', { field: 'template.name' });
  }
  // Absent stays absent (undefined), never null: the adapter defaults an
  // undefined language to the approved entry's, while null reads as an
  // explicit wrong language and is refused.
  const language = value.language === undefined || value.language === null || value.language === ''
    ? undefined
    : boundedLine(value.language, 'template.language', 16);
  if (language !== undefined && !TEMPLATE_LANGUAGE_RE.test(language)) {
    throw new ValidationError('template.language must look like "it" or "it_IT"', { field: 'template.language' });
  }
  const variables = value.variables === undefined || value.variables === null ? [] : value.variables;
  if (!Array.isArray(variables) || variables.length > MAX_TEMPLATE_VARIABLES
    || variables.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > MAX_VARIABLE_CHARS)) {
    throw new ValidationError(
      'template.variables must be a bounded list of non-empty text (at most 32, at most 1024 chars each)',
      { field: 'template.variables' },
    );
  }
  return { name, language, variables: [...variables] };
}

/**
 * @param {{
 *   registries?: any,
 *   resolveSecret?: ((ref: string, context?: any) => Promise<string>) | null,
 *   moduleNames?: Record<string, string>,
 *   sendTimeoutMs?: number,
 * }} [options] `registries` is the composed `ChannelRegistries` (adapters);
 *   `resolveSecret` the deployment's custody edge. Both arrive from the
 *   channels package factory, never from the caller.
 */
export function createTemplateSendCapability(options = {}) {
  const registries = options.registries ?? null;
  const resolveSecret = options.resolveSecret ?? null;
  const connectionModule = options.moduleNames?.connectionModule ?? 'channel-connection';
  const sendTimeoutMs = Number.isInteger(options.sendTimeoutMs) && options.sendTimeoutMs > 0
    ? options.sendTimeoutMs
    : CHANNEL_SEND_TIMEOUT_MS;

  function connections(modules) {
    const service = modules?.get?.(connectionModule)?.service;
    if (!service?.listWhere) {
      throw new AppError('The channels package is installed without its "channel-connection" records', {
        code: 'CHANNEL_STORAGE_INVALID', status: 500,
      });
    }
    return service;
  }

  function requireAdapter(connection) {
    if (!registries || typeof registries.getAdapter !== 'function') {
      throw new AppError('The channels package is composed without its adapter registries', {
        code: 'CHANNEL_STORAGE_INVALID', status: 500,
      });
    }
    try {
      const { definition } = registries.getAdapter(connection.adapter, connection.adapterVersion);
      if (!definition || typeof definition.normalizeOutbound !== 'function' || typeof definition.sendOutbound !== 'function') {
        throw new Error('adapter without send surface');
      }
      return definition;
    } catch {
      throw new AppError(`Unknown channel adapter "${connection.adapter}@${connection.adapterVersion}"`, {
        code: 'CHANNEL_ADAPTER_UNKNOWN', status: 500,
      });
    }
  }

  async function resolveTarget(modules, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new ValidationError('a template send needs a request object', { field: 'request' });
    }
    const value = /** @type {any} */ (request);
    const spaceId = assertSpaceId(value.spaceId);
    const connectionKey = boundedLine(value.connectionKey, 'connectionKey', MAX_CONNECTION_KEY);
    const to = assertRecipient(value.to);
    const template = assertTemplateInput(value.template);
    const rows = await connections(modules).listWhere({ spaceId, sourceKey: connectionKey });
    const connection = rows[0] ?? null;
    if (!connection) {
      throw new AppError('Unknown channel connection', { code: 'CHANNEL_CONNECTION_UNKNOWN', status: 404 });
    }
    if (connection.status !== 'active') {
      throw new AppError(`Channel connection is ${connection.status}`, {
        code: 'CHANNEL_CONNECTION_NOT_ACTIVE', status: 409,
      });
    }
    const adapter = requireAdapter(connection);
    // The structural guard: only an adapter-normalized approved template
    // leaves this seam. Free text cannot be expressed (there is no text
    // field), an unapproved template is refused here by the adapter, and a
    // channel without template support refuses with CHANNEL_TEMPLATE_REQUIRED.
    let normalized;
    try {
      normalized = adapter.normalizeOutbound({ to, template }, undefined);
    } catch (error) {
      // Both refusal codes travel intact, exactly like
      // `normalizeOutboundMessage` in operations.js: the template code and
      // the inbound-only refusal. Anything else is a malformed message.
      const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : null;
      if (code === 'CHANNEL_TEMPLATE_REQUIRED' || code === 'CHANNEL_SEND_UNSUPPORTED') throw error;
      throw new AppError('Channel message is not well-formed', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
    }
    if (!normalized || normalized.kind !== 'template') {
      throw new AppError('This seam sends approved templates only', {
        code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
      });
    }
    return { spaceId, connection, adapter, to: normalized.to, template: normalized.template };
  }

  return {
    name: 'channel-template-send',
    version: 1,
    description:
      'Send one approved channel template to one recipient right now (automatic reminders). '
      + 'Template-only by construction: free text cannot be expressed, an unapproved template is refused by the '
      + 'adapter, and the secret is resolved at call time and never stored. Synchronous with a bounded timeout; '
      + 'retries belong to the caller.',
    /** @param {{modules: any}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('channel-template-send@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      return Object.freeze({
        capabilityContract: 1,
        /**
         * Prove a reminder target sends, without sending: the booking path
         * fails fast on an unknown connection or an unapproved template
         * instead of learning it at the instant.
         */
        checkSendable: async (request) => {
          requireActor(request?.actor);
          const target = await resolveTarget(modules, request);
          return Object.freeze({
            channel: target.connection.channel,
            to: target.to,
            template: Object.freeze({ name: target.template.name, language: target.template.language }),
          });
        },
        /**
         * Send one approved template now. `messageKey` is the caller's
         * idempotency identity (the reminder's deterministic key): a retry
         * under the same key replays the provider's answer on the fake and
         * must be the same send on every adapter.
         */
        sendTemplate: async (request) => {
          requireActor(request?.actor);
          const target = await resolveTarget(modules, request);
          const messageKey = boundedLine(
            /** @type {any} */ (request)?.messageKey, 'messageKey', MAX_CONNECTION_KEY,
          );
          if (typeof resolveSecret !== 'function') {
            throw new AppError('Channel secret custody is not wired: sends refuse until the deployment resolves secrets', {
              code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500,
            });
          }
          let secret;
          try {
            secret = await resolveSecret(target.connection.secretRef, {
              spaceId: target.spaceId, purpose: CHANNEL_SECRET_PURPOSE_OUTBOUND,
            });
          } catch {
            secret = null;
          }
          if (typeof secret !== 'string' || secret === '') {
            throw new AppError('Channel secret is unavailable', {
              code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500,
            });
          }
          let sent;
          try {
            sent = await withTimeout(
              Promise.resolve(target.adapter.sendOutbound({
                message: { to: target.to, kind: 'template', template: target.template },
                secret,
                idempotencyKey: messageKey,
                config: target.adapter.config,
              })),
              sendTimeoutMs,
              `channel adapter "${target.adapter.name}" sendOutbound`,
            );
          } catch (error) {
            const normalizedError = normalizeError(error);
            // Retryable provider states travel intact so the caller's job
            // can ride them; worker-control codes are never adapter
            // vocabulary and land as refusals, like the outbox handler.
            if (normalizedError.code === 'CHANNEL_SEND_TRANSIENT' || normalizedError.code === 'PROVIDER_TIMEOUT') {
              throw error;
            }
            const rawCode = /** @type {any} */ (error)?.code;
            if (typeof rawCode === 'string' && !['JOB_HANDLER_FAILED', 'JOB_HANDLER_TEMPORARY_UNAVAILABLE'].includes(rawCode)
              && /^[A-Z][A-Z0-9_]*$/.test(rawCode)) throw error;
            throw new AppError('Channel provider refused this template send', {
              code: 'CHANNEL_SEND_REFUSED', status: 502,
            });
          }
          const providerMessageId = sent && typeof sent.providerMessageId === 'string' ? sent.providerMessageId : '';
          if (providerMessageId === '' || providerMessageId.length > PROVIDER_MESSAGE_ID_MAX) {
            throw new AppError('Channel send is unproven: the provider named no message', {
              code: 'CHANNEL_SEND_UNPROVEN', status: 502,
            });
          }
          return Object.freeze({
            providerMessageId,
            channel: target.connection.channel,
            to: target.to,
            template: Object.freeze({ name: target.template.name, language: target.template.language }),
          });
        },
      });
    },
  };
}
