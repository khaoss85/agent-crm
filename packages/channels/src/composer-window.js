// @ts-check

/**
 * The scheda composer WhatsApp window (backlog:97cba17c, VALIDAZIONE A4):
 * what the «Scrivi» composer may send on WhatsApp depends on Meta's
 * 24-hour customer-service window, and the composer says so in Italian
 * before anything is queued — never a free-text send Meta would refuse
 * in silence.
 *
 * Zero dependencies beyond the shared Meta rule: this module calls
 * `checkMetaServiceWindow` (the one function the whatsapp adapter and the
 * queue both call), never a copy of it. The skew matches
 * `CHANNEL_INGEST_FUTURE_SKEW_MS` in `./operations.js`: an observation
 * the ingest path kept as in-window evidence opens the composer window
 * too.
 */

import {
  META_CUSTOMER_SERVICE_WINDOW_MS,
  checkMetaServiceWindow,
} from './meta-webhook.js';

/** The ingest skew the queue applies, restated as the composer's own default. */
export const COMPOSER_WINDOW_SKEW_MS = 5 * 60 * 1000;

/** Template names: lowercase letters, digits, underscores (the adapter's own bound). */
const TEMPLATE_NAME = /^[a-z0-9_]{1,64}$/;
/** Template languages: `xx` or `xx_YY` (the adapter's own bound). */
const TEMPLATE_LANGUAGE = /^[a-z]{2}(?:_[A-Z]{2})?$/;

/** Free text may go: the last customer message is still inside 24 hours. */
export const WHATSAPP_COMPOSER_FREE = 'free';
/** Only approved templates may go: outside the window, or no inbound seen. */
export const WHATSAPP_COMPOSER_TEMPLATE_ONLY = 'template-only';

/**
 * The Italian line the composer shows outside the window. One sentence:
 * what happened, and what may still go.
 */
function closedNotice() {
  return 'Sono passate più di 24 ore dall’ultimo messaggio del cliente su WhatsApp: puoi mandare solo un modello approvato, non un testo libero che Meta rifiuterebbe.';
}

/**
 * Keep only the displayable approved templates: bounded name and language,
 * frozen. The queue still approves strictly at send time — this list only
 * decides what the composer proposes, never what may go.
 *
 * @param {unknown} value the adapter's approved templates
 * @returns {Array<{name: string, language: string}>} the frozen proposable list
 */
export function proposableWhatsAppTemplates(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const kept = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const language = typeof entry.language === 'string' ? entry.language : '';
    if (!TEMPLATE_NAME.test(name) || !TEMPLATE_LANGUAGE.test(language)) continue;
    if (kept.length >= 64) break;
    kept.push(Object.freeze({ name, language }));
  }
  return Object.freeze(kept);
}

/**
 * What the WhatsApp composer may send right now, in the composer's own
 * words. Pure: the same observation refuses the same way at the route and
 * at the queue.
 *
 * @param {{lastInboundAt?: unknown, nowMs?: number, approvedTemplates?: unknown}} [input]
 * @returns {{mode: 'free'|'template-only', inWindow: boolean, noticeIt: string|null, templates: Array<{name: string, language: string}>}}
 */
export function describeWhatsAppComposer({ lastInboundAt = null, nowMs = Date.now(), approvedTemplates = [] } = {}) {
  const verdict = checkMetaServiceWindow(lastInboundAt ?? null, {
    nowMs: () => nowMs,
    windowMs: META_CUSTOMER_SERVICE_WINDOW_MS,
    skewMs: COMPOSER_WINDOW_SKEW_MS,
  });
  if (verdict === 'ok') {
    return Object.freeze({
      mode: WHATSAPP_COMPOSER_FREE,
      inWindow: true,
      noticeIt: null,
      templates: Object.freeze([]),
    });
  }
  return Object.freeze({
    mode: WHATSAPP_COMPOSER_TEMPLATE_ONLY,
    inWindow: false,
    noticeIt: closedNotice(),
    templates: proposableWhatsAppTemplates(approvedTemplates),
  });
}

/**
 * Why a WhatsApp free text cannot go now, in Italian — or null when it can.
 * The route refuses fast with this line instead of queueing a send the
 * worker would refuse with `CHANNEL_TEMPLATE_REQUIRED`.
 *
 * @param {{lastInboundAt?: unknown, nowMs?: number}} [input]
 * @returns {string|null} the Italian refusal, or null when free text may go
 */
export function refuseWhatsAppFreeText({ lastInboundAt = null, nowMs = Date.now() } = {}) {
  const state = describeWhatsAppComposer({ lastInboundAt, nowMs });
  return state.inWindow ? null : state.noticeIt;
}
