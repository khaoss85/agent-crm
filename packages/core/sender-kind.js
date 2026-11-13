// @ts-check
/**
 * Narrow public entry of the kernel for the sender rule (backlog:bab63e32acdb,
 * backlog:c2bf6b206d96): person or machine, one rule for the Gmail door,
 * lead names, the Clienti «Da rispondere» view and the Oggi inbox.
 * Packages import it from here, never from `src/`, and not through
 * `index.js` (see message-preview.js for why). The /bo shell carries a
 * byte-identical copy of the source (apps/admin/public/admin-sender-kind.js).
 */
export {
  AUTOMATED_SENDER_LOCALS,
  ITALIAN_ROLE_LOCALS,
  NOTIFICATION_DOMAINS,
  NO_REPLY_WORD,
  PAYMENT_PROVIDERS,
  PEC_PROVIDERS,
  PERSONAL_MAIL_DOMAINS,
  RECEIPT_LOCALS,
  SECOND_LEVEL_SUFFIXES,
  SENDING_SUBDOMAINS,
  hasBulkFooter,
  isAutomatedAddress,
  isAutomatedSender,
  isNotificationMessage,
  isTechnicalLocalPart,
  labelFromEmail,
  registrableDomain,
  senderAddress,
  teamCorrespondents,
  teamWroteTo,
} from './src/sender-kind.js';
