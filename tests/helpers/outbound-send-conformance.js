// @ts-check

import assert from 'node:assert/strict';

/**
 * Reusable conformance for packages that send to external channels
 * (backlog:9417be26).
 *
 * Three concurrency cases every outbound sender must survive, distilled from
 * the appointment-reminder review rounds that each fixed one of them in
 * `packages/appointments/src/reminder-dispatch.js`:
 *
 * 1. two racing sweeps queue a single outbox job and send once;
 * 2. a crash between the provider send and the confirm records once;
 * 3. a row cancelled between the list and the fire never queues.
 *
 * The helper owns the orchestration and the assertions; the calling package
 * owns composition and fault injection through the driver. The helper never
 * imports a domain package and must stay that way: if a check here needs a
 * domain concept, it belongs in that package's own tests.
 *
 * Driver shape:
 *
 * ```js
 * {
 *   label: 'appointment reminders', // names the package in assertion messages
 *   now: { queue: '<iso instant to queue at>', confirm: '<later iso instant to confirm at>' },
 *   createRacingStacks: async () => ({ first, second, cleanup() }),
 *     // two stacks over one shared store, each with one due row, like two dynos
 *   createStack: async () => ({ stack, cleanup() }),
 *     // one stack with one due row
 *   dispatch: async (stack, at) => ({ queued: [{ jobId }], sent: [...] }),
 *     // fire the sweep at `at`; encapsulates the package's own transient-conflict retry
 *   dispatchWithCancelledRow: async (stack, at) => ({ queued, sent }),
 *     // the due row dies between the list and the fire (cancel, reschedule)
 *   dispatchWithCrashingConfirm: async (stack, at) => { throw ... },
 *     // the confirm writes history, then crashes before the marker: rejects,
 *     // history stays, the marker stays empty
 *   settleJob: async (stack, jobId) => undefined,
 *     // run the outbox worker until the job settles (sends through the real handler)
 *   providerSendCalls: (stack) => 1, // how many provider bytes left this stack
 *   outboxJobCount: async (stack) => 1, // channel-send jobs stored
 *   historyCount: async (stack) => 1, // recorded outbound history rows
 *   markerValue: async (stack) => '<the row\'s sent marker, empty until confirmed>',
 *     // the confirm stamps the instant the job was queued for (`now.queue`),
 *     // never the confirming beat's clock
 * }
 * ```
 */

/**
 * @param {any} driver the calling package's composition and fault injection
 */
export async function checkConcurrentSweepsQueueOneJob(driver) {
  const { first, second, cleanup } = await driver.createRacingStacks();
  try {
    // Two sweeps racing queue the same job: the persistent enqueue is the
    // cross-process claim, so the loser gets the winner's row back and no
    // second send exists to make either way.
    const [one, two] = await Promise.all([
      driver.dispatch(first, driver.now.queue),
      driver.dispatch(second, driver.now.queue),
    ]);
    assert.equal(one.queued.length, 1, `${driver.label}: the first racing sweep queues one job`);
    assert.equal(two.queued.length, 1, `${driver.label}: the second racing sweep queues one job`);
    assert.equal(
      one.queued[0].jobId, two.queued[0].jobId,
      `${driver.label}: racing sweeps share one outbox job, never two`,
    );
    assert.equal(await driver.outboxJobCount(first), 1, `${driver.label}: one reminder is one outbox job`);

    // The worker sends once under the message key ...
    await driver.settleJob(first, one.queued[0].jobId);
    assert.equal(driver.providerSendCalls(first), 1, `${driver.label}: the provider is called once`);

    // ... and the confirm (plus its replay) changes nothing: one history
    // row, one marker, no second job, no second send.
    const confirmed = await driver.dispatch(first, driver.now.confirm);
    assert.equal(confirmed.sent.length, 1, `${driver.label}: the confirm records the finished job`);
    assert.equal(
      await driver.markerValue(first), driver.now.queue,
      `${driver.label}: the marker stamps the queued-for instant, never the confirming beat's clock`,
    );
    const replayed = await driver.dispatch(first, driver.now.confirm);
    assert.equal(replayed.sent.length, 0, `${driver.label}: a replay after the confirm sends nothing`);
    assert.equal(replayed.queued.length, 0, `${driver.label}: a replay after the confirm queues nothing`);
    assert.equal(driver.providerSendCalls(first), 1, `${driver.label}: the replay sends nothing again`);
    assert.equal(await driver.historyCount(first), 1, `${driver.label}: one send is one history row`);
  } finally {
    await cleanup();
  }
}

/**
 * @param {any} driver the calling package's composition and fault injection
 */
export async function checkCrashBetweenSendAndConfirmSendsOnce(driver) {
  const { stack, cleanup } = await driver.createStack();
  try {
    const queued = await driver.dispatch(stack, driver.now.queue);
    assert.equal(queued.queued.length, 1, `${driver.label}: the sweep queues one job`);
    await driver.settleJob(stack, queued.queued[0].jobId);
    assert.equal(driver.providerSendCalls(stack), 1, `${driver.label}: the provider is called once`);

    // The confirm writes history, then crashes before the marker: the sweep
    // fails, the history row stays, the marker stays empty.
    await assert.rejects(
      driver.dispatchWithCrashingConfirm(stack, driver.now.queue),
      `${driver.label}: a crash between history and marker fails the sweep`,
    );
    assert.equal(await driver.historyCount(stack), 1, `${driver.label}: the crashed confirm keeps its history row`);
    assert.ok(!await driver.markerValue(stack), `${driver.label}: the crashed confirm leaves the marker empty`);

    // The next beat, on another clock, replays the identical history row
    // instead of conflicting, and the marker lands: one send, one row.
    const retried = await driver.dispatch(stack, driver.now.confirm);
    assert.equal(retried.sent.length, 1, `${driver.label}: the retry after the crash confirms once`);
    assert.equal(await driver.historyCount(stack), 1, `${driver.label}: the retry replays the same history row`);
    assert.equal(
      await driver.markerValue(stack), driver.now.queue,
      `${driver.label}: the marker stamps the queued-for instant, never the retry's clock`,
    );
    assert.equal(driver.providerSendCalls(stack), 1, `${driver.label}: the retry sends nothing again`);
  } finally {
    await cleanup();
  }
}

/**
 * @param {any} driver the calling package's composition and fault injection
 */
export async function checkCancelledRowNeverQueues(driver) {
  const { stack, cleanup } = await driver.createStack();
  try {
    // The due list is only a snapshot: a row that died between the list
    // and the fire is skipped on its fresh re-read, and nothing is queued.
    const fired = await driver.dispatchWithCancelledRow(stack, driver.now.queue);
    assert.equal(fired.sent.length, 0, `${driver.label}: a row cancelled mid-sweep sends nothing`);
    assert.equal(fired.queued.length, 0, `${driver.label}: a row cancelled mid-sweep queues nothing`);
    assert.equal(driver.providerSendCalls(stack), 0, `${driver.label}: a row cancelled mid-sweep calls no provider`);
    assert.equal(await driver.outboxJobCount(stack), 0, `${driver.label}: a row cancelled mid-sweep leaves no job`);
  } finally {
    await cleanup();
  }
}

/**
 * All three outbound-send cases in sweep order: race, crash, cancel.
 *
 * @param {any} driver the calling package's composition and fault injection
 */
export async function runOutboundSendConformance(driver) {
  await checkConcurrentSweepsQueueOneJob(driver);
  await checkCrashBetweenSendAndConfirmSendsOnce(driver);
  await checkCancelledRowNeverQueues(driver);
}
