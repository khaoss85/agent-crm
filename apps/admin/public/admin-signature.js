// @ts-check

/**
 * backlog:0550bea56168: the Firma box never tells the titolare to ask the
 * titolare. The titolare reads what they can do themself; everyone else
 * reads whom to ask (the Assistente idiom, backlog:1968c3320cd3).
 */

/** The signature is off here: what everyone else reads — whom to ask. */
export const SIGNATURE_SPACE_DISABLED_NOTICE = 'La firma non è attiva qui. Per accenderla chiedi al titolare.';

/** The signature is off here: what the titolare reads — what they can do. */
export const SIGNATURE_SPACE_DISABLED_OWNER_NOTICE = 'La firma non è attiva qui. Puoi accenderla da Spazi e accessi.';

/**
 * The signature-off line for a session role: only the titolare is told what
 * they can do; every other role (and an unknown one) is told whom to ask.
 * @param {unknown} role
 */
export function signatureOffNotice(role) {
  return role === 'owner' ? SIGNATURE_SPACE_DISABLED_OWNER_NOTICE : SIGNATURE_SPACE_DISABLED_NOTICE;
}
