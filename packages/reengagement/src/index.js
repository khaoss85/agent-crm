// @ts-check

import { AppError, ValidationError, definePackage, selectPackageGraph } from '../../core/index.js';
import {
  REENGAGEMENT_ACTION_KIND,
  REENGAGEMENT_CONSENTS,
  REENGAGEMENT_DEFAULT_QUIET_DAYS,
  REENGAGEMENT_INBOUND_CHANNELS,
  REENGAGEMENT_PACKAGE,
  REENGAGEMENT_PERMISSION,
  REENGAGEMENT_WINDOW_CHANNELS,
  scanReengagement,
} from './reengagement.js';

/**
 * The re-engagement domain package (backlog:f50ad5c9).
 *
 * A teammate agent above the channels window rule and the
 * llm composer: every day it finds the customers who arrived from
 * WhatsApp, Instagram or email and were never answered — or not contacted
 * for N days — and prepares one message each with the card's own history
 * on the right channel. Outside the 24-hour Meta window it proposes an
 * approved template or another connected channel, never free text, and it
 * never proposes an opted-out customer.
 *
 * It owns no records (MEM_ACC_REUSE): candidates arrive as caller values,
 * the approval queue is the agents package's `teammate-run` (backlog:
 * fd36da512b0e — «Da fare» lists the runs with outcome `proposed`, so
 * `createReengagementExecutor` is the `execute` seam of `run-due` and the
 * human approves, edits or rejects that row), follow-up tasks stay
 * `work-task` in work, and the send stays the channels outbox. The
 * permission that turns a proposal into an autonomous send is the existing
 * `send-without-approval` switch — no new permission, no new table.
 *
 * `draftText` is the wording edge, injected at composition like the
 * channels llm handover: without it the scan refuses with a code instead
 * of proposing blind. `windowState` arrives per customer from the channels
 * inbox read the caller owns; the window rule itself is never re-declared
 * here.
 *
 * What is deliberately NOT here: the daily timer (the deployment owns the
 * schedule), the inbox and window reads (channels owns them), the approval
 * row (agents records the run) and the send (the deployment's applyAction
 * seam, after the human or the switch decides). The operation below
 * computes; executing stays the consumer's job.
 */

export const REENGAGEMENT_DOMAIN = REENGAGEMENT_PACKAGE;
export const REENGAGEMENT_OPERATION = 'scan-reengagement';

/**
 * @param {{draftText?: ((input: any) => Promise<any>) | null}} [options]
 */
export function createReengagementPackage(options = {}) {
  const { draftText = null } = options;
  if (draftText !== null && typeof draftText !== 'function') {
    throw new ValidationError('reengagement draftText must be a wording function or null', {
      field: 'draftText',
    });
  }

  const graph = definePackage({
    packageContract: 1,
    name: REENGAGEMENT_DOMAIN,
    // 1: f50ad5c9 — daily scan over caller customers, window-honest routes,
    // approval-shaped proposals, no records of its own.
    // 2: fd36da512b0e — proposals travel as teammate-run rows («Da fare»)
    // through the run-due executor, never as space-ai-proposal rows.
    version: 2,
    label: 'Re-engagement agent',
    description:
      'The teammate agent that re-contacts silent customers: selects who arrived from WhatsApp, Instagram '
      + 'or email and was never answered or not contacted for N days, decides the sendable route per channel '
      + 'window, and returns approval-shaped proposals with a drafted knock. Owns no records and sends nothing.',
    resources: [],
    // Nothing declared: candidates, window states and consent arrive as
    // caller values, and the wording edge arrives as the options seam.
    // A caller that needs the scan inside its own transaction imports the
    // pure core; the operation below serves the host worker.
    requires: [],
    capabilities: [],
    actions: [],
    operations: [
      {
        operationContract: 1,
        name: REENGAGEMENT_OPERATION,
        appMethod: 'scanReengagement',
        label: 'Scan silent customers',
        description:
          'Find the customers silent for quietDays, decide each sendable route, and draft each knock. '
          + 'Refuses when the wording edge is not composed; records and sends nothing.',
        input: [
          { name: 'customers', type: 'json', required: true, hint: 'Caller-observed customers with consent, window states and history.' },
          { name: 'quietDays', type: 'json', required: false, hint: 'Days of silence before the knock (default 7, 1-90).' },
        ],
        create() {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            if (draftText === null) {
              throw new AppError('The reengagement scan is composed without its wording edge', {
                code: 'REENGAGEMENT_DRAFT_UNAVAILABLE', status: 500,
              });
            }
            return scanReengagement({
              customers: record.customers,
              quietDays: record.quietDays,
              nowMs: Date.now(),
              draftText,
            });
          };
        },
      },
    ],
    policies: [],
    /** Function-free, additive schema metadata. */
    metadata() {
      return {
        reengagementContract: 2,
        approvalQueue: 'teammate-run',
        inboundChannels: [...REENGAGEMENT_INBOUND_CHANNELS],
        windowedChannels: [...REENGAGEMENT_WINDOW_CHANNELS],
        defaultQuietDays: REENGAGEMENT_DEFAULT_QUIET_DAYS,
        actionKind: REENGAGEMENT_ACTION_KIND,
        permission: REENGAGEMENT_PERMISSION,
        consents: [...REENGAGEMENT_CONSENTS],
        notModeled: [
          'daily schedule: the deployment owns the timer; the operation only computes one scan',
          'window observation: channels owns the inbox read; windowState arrives as a caller value',
          'wording: llm owns the composer; draftText is the injected seam',
          'approval rows: the agents package records each run as a teammate-run; createReengagementExecutor is its run-due execute seam',
          'sends: the channels outbox owns them; the deployment applyAction seam executes an approved proposal',
        ],
      };
    },
  });

  return selectPackageGraph(graph, 1);
}

export {
  REENGAGEMENT_ACTION_KIND,
  REENGAGEMENT_CONSENTS,
  REENGAGEMENT_DEFAULT_QUIET_DAYS,
  REENGAGEMENT_INBOUND_CHANNELS,
  REENGAGEMENT_PACKAGE,
  REENGAGEMENT_PERMISSION,
  REENGAGEMENT_MAX_PAYLOAD_CHARS,
  REENGAGEMENT_MAX_PROPOSALS_PER_RUN,
  REENGAGEMENT_WINDOW_CHANNELS,
  createReengagementExecutor,
  scanReengagement,
} from './reengagement.js';
