import { join } from 'node:path';
import { POLICY, boot, project, signedOrder } from './contracts-project.js';

export { POLICY };
export const ACTOR = { type: 'user', id: 'integrity' };
export const TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};
export const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];

/** A signed order with a signed term, ready to activate. */
export async function scene(t, tag) {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  const { app } = context;
  const signed = await signedOrder(root, app, { name: `${tag} deal`, offers: OFFERS, term: TERM });
  return { root, context, app, db: app.database.raw, ...signed };
}

export async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message), details: error.details ?? null };
  }
}

export const activate = (app, orderId) => app.runAction({
  module: 'order', action: 'activate-contract', recordId: orderId, input: { ...POLICY }, actor: ACTOR,
});

/**
 * Every single-field tamper on the Order's signed-term snapshot. Each one keeps
 * `document_hash` intact — that check already existed and is not what this
 * suite is about; what is new is that the values must match the fingerprint
 * they carry and the authoritative version snapshot they were copied from.
 */
export const FIELD_TAMPERS = [
  ['effectiveDate alone', "UPDATE order_terms SET effective_date = '2026-01-01' WHERE order_id = ?"],
  ['termStartDate alone', "UPDATE order_terms SET term_start_date = '2026-10-01' WHERE order_id = ?"],
  ['termEndDate alone', "UPDATE order_terms SET term_end_date = '2099-12-31' WHERE order_id = ?"],
  ['termDays alone', 'UPDATE order_terms SET term_days = 99999 WHERE order_id = ?'],
  ['autoRenew alone', 'UPDATE order_terms SET auto_renew = 0 WHERE order_id = ?'],
  ['renewalNoticeDays alone', 'UPDATE order_terms SET renewal_notice_days = 5 WHERE order_id = ?'],
  ['termsContract alone', 'UPDATE order_terms SET terms_contract = 2 WHERE order_id = ?'],
  ['termsFingerprint alone', "UPDATE order_terms SET terms_fingerprint = 'f' || substr(terms_fingerprint, 2) WHERE order_id = ?"],
];

/** The canonical fingerprint, computed the way the package computes it. */
export async function fingerprintOf(term) {
  const { signedTermFingerprint } = await import('../../packages/commercial/src/terms.js');
  return signedTermFingerprint(term);
}

export const FORGED = Object.freeze({
  termsContract: 1, effectiveDate: '2026-09-01', termStartDate: '2026-09-01',
  termEndDate: '2030-12-31', termDays: 1583, autoRenew: true, renewalNoticeDays: 60,
});
