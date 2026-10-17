// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import {
  CALL_DIRECTIONS,
  CALL_MODULE,
  CALL_OUTCOMES,
  CHANNELS,
  CONVERSATION_MODULE,
  CONVERSATION_STATES,
  CONVERSATION_TRANSITIONS,
  INTERACTIONS_PACKAGE,
  MESSAGE_DIRECTIONS,
  MESSAGE_INITIAL,
  MESSAGE_MODULE,
  MESSAGE_STATES,
  MESSAGE_TERMINAL,
  MESSAGE_TRANSITIONS,
  advanceMessage,
  buildAdvanceMessageAction,
  buildCloseConversationAction,
  createInteractionLogCapability,
  createInteractionTimelineCapability,
  logCall,
  logMessage,
  openConversation,
  readConversationThread,
  readTimeline,
  sortEntries,
  validateCallRequest,
  validateConversationRequest,
  validateMessageRequest,
  validateSubject,
} from './interactions.js';

/**
 * **Interactions v1 — the native message and call records.**
 *
 * What it does: holds one conversation thread per customer per channel, logs
 * inbound and outbound messages with the outbound delivery lifecycle
 * (`sent -> delivered -> read`, plus `-> failed` with a reason code), logs
 * calls with their outcome and duration, and reads one subject's history —
 * messages, calls and the work-activity entries on the same subject — oldest
 * first, for the customer card.
 *
 * What it deliberately is **not**: a channel integration (no provider send,
 * no webhook, no polling — adapters log here, and the fake-adapter kit in the
 * consuming project is where delivery is faked); an identity system (channel
 * handles name records through `customer-data/external-identity`, and
 * `remoteHandle` here is a display snapshot); a scheduler, a reminder system
 * or a notification system; a project-management or assignment system; a
 * consent or recording-disclosure system for calls.
 *
 * **The governing choice, inherited from ADR-030:** the subject is an opaque
 * envelope pointing at a record the host application owns. There is no master
 * customer table here and none is created; `work-activity` stays the record of
 * human follow-up work and is only read, never written, by this package.
 */

export const INTERACTIONS_DOMAIN = INTERACTIONS_PACKAGE;

/**
 * The records this package owns. None of them duplicates a business record:
 * no other package holds conversations, messages or calls, and the subject
 * envelope points at host records rather than copying them.
 */
export const INTERACTIONS_RESOURCES = Object.freeze([
  CONVERSATION_MODULE,
  MESSAGE_MODULE,
  CALL_MODULE,
]);

export {
  CALL_DIRECTIONS,
  CALL_OUTCOMES,
  CHANNELS,
  CONVERSATION_STATES,
  CONVERSATION_TRANSITIONS,
  MESSAGE_DIRECTIONS,
  MESSAGE_INITIAL,
  MESSAGE_STATES,
  MESSAGE_TERMINAL,
  MESSAGE_TRANSITIONS,
  advanceMessage,
  logCall,
  logMessage,
  openConversation,
  readConversationThread,
  readTimeline,
  sortEntries,
  validateCallRequest,
  validateConversationRequest,
  validateMessageRequest,
  validateSubject,
};

/** @param {{config?: Record<string, string>}} [options] */
export function createInteractionsPackage(options = {}) {
  const config = options.config;
  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: INTERACTIONS_DOMAIN,
    version: 1,
    label: 'Customer messages and calls',
    description:
      'Native message and call evidence: one conversation thread per customer per channel, inbound and outbound '
      + 'messages with the outbound delivery lifecycle, calls with outcome and duration, and one read-only '
      + 'timeline merging messages, calls and work-activity for the customer card. It sends nothing and schedules nothing.',
    resources: [...INTERACTIONS_RESOURCES],

    // Nothing. The timeline reads work-activity through the runtime modules
    // handle and reports it unavailable when the work package is not composed
    // — an optional read, exactly like the customer-data profile's optional
    // sections — so no composition that adds this package can create a
    // dependency cycle.
    requires: [],

    capabilities: [createInteractionLogCapability(config), createInteractionTimelineCapability(config)],
    actions: [buildAdvanceMessageAction(config), buildCloseConversationAction(config)],

    // None. A versioned policy earns its fingerprint when two consumers share
    // a rule; the channel vocabulary and the transition tables are published
    // in metadata and owned by this package alone.
    policies: [],

    /**
     * The machine-readable contract, function-free. Admin renders from this
     * and the limits are part of it rather than prose somebody may not read.
     */
    metadata() {
      return {
        interactionsContract: 1,
        channels: [...CHANNELS],
        conversation: {
          states: [...CONVERSATION_STATES],
          transitions: Object.fromEntries(
            Object.entries(CONVERSATION_TRANSITIONS).map(([from, to]) => [from, [...to]]),
          ),
        },
        message: {
          directions: [...MESSAGE_DIRECTIONS],
          states: [...MESSAGE_STATES],
          initial: { ...MESSAGE_INITIAL },
          transitions: Object.fromEntries(
            Object.entries(MESSAGE_TRANSITIONS).map(([from, to]) => [from, [...to]]),
          ),
          terminal: [...MESSAGE_TERMINAL],
          idempotency: 'same source key with the same payload replays the stored row; a divergent payload behind the same key is refused 409, never adopted',
          failure: 'a failure is recorded only as an advance to failed with a reason code; a fresh message never carries one',
        },
        call: {
          directions: [...CALL_DIRECTIONS],
          outcomes: [...CALL_OUTCOMES],
          immutable: 'the outcome is recorded once, at log time, and never transitions; a second attempt is a new call under a new source key',
          duration: 'whole seconds, 0 to 86400; 0 unless the outcome is completed',
        },
        timeline: {
          readOnly: true,
          order: 'occurredAt oldest-first; ties break on creation stamp, then id — determinism, not chronology',
          reads: 'complete exact-match queries, never bounded display pages',
          workActivity: 'optional: absent without the work package, reported as not available rather than empty',
        },
        provenance: 'source.package is bound to the registry-resolved consumer, or to host for direct host calls; a mismatched assertion is refused 403',
        limitations: [
          'No provider send, receive, webhook or polling exists here: adapters log evidence, and delivery outside the log is faked by the consuming project.',
          'remoteHandle is a display snapshot, never an identifier: channel identity lives in customer-data external-identity.',
          'A message names its conversation with a plain string: the_subject envelope on the row is what the timeline reads, and a conversation row is not required to exist.',
          'body is bounded plain text without control characters or line breaks: no provider payload, no attachment and no markup is stored.',
          'Call recording, consent and disclosure are not modeled: duration and outcome are the whole record.',
        ],
        notModeled: ['channel provider integration', 'message sending or delivery', 'webhook ingestion', 'channel identity resolution',
          'duplicate detection across channels', 'scheduling', 'reminders', 'notifications', 'assignment or ownership',
          'read-receipt semantics beyond the stored state', 'call recording or consent', 'cross-channel threading'],
      };
    },
  }), options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createInteractionsPackage()` callers keep v1. */
export function createInteractionsPackageV2(options = {}) {
  return createInteractionsPackage({ ...options, packageContract: 2 });
}
