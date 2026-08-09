import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * The keep-alive reap must not reset a request the server has already accepted.
 *
 * The race this pins down, which showed up as an intermittent ECONNRESET in the
 * delivery evidence suite: Node arms a keep-alive timer when a response
 * finishes, and its default reap is `socket.destroy()`. The event loop runs
 * TIMERS BEFORE POLL, so once that timer is overdue — which is what happens
 * whenever the loop has been blocked for longer than the keep-alive window —
 * the reap fires before the poll phase delivers request bytes that are already
 * in the socket's receive queue, and closing a socket with unread data answers
 * RST. A client that reused the connection loses an accepted request.
 *
 * Both halves are pinned here, because a "fix" that simply stopped reaping
 * would pass the first test and leak connections forever.
 */

/** @param {import('node:test').TestContext} t @param {number} keepAliveTimeout */
async function startServer(t, keepAliveTimeout) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  server.keepAliveTimeout = keepAliveTimeout;
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  server.on('connection', (socket) => accepted.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of accepted) socket.destroy();
    server.close(() => { app.close(); resolve(undefined); });
  }));
  return { server, accepted, port: /** @type {any} */ (server.address()).port };
}

/** A keep-alive GET written as raw bytes, so the test controls exactly when it is sent. */
const request = (port) => [
  'GET /api/notifications HTTP/1.1',
  `Host: 127.0.0.1:${port}`,
  'connection: keep-alive',
  '', '',
].join('\r\n');

/** @param {import('node:net').Socket} socket */
function nextResponse(socket) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => { done(); resolve(chunk.toString('utf8').split('\r\n')[0]); };
    const onError = (error) => { done(); reject(error); };
    const onClose = () => { done(); reject(new Error('the connection closed without a response')); };
    function done() {
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
    }
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
  });
}

test('a request that arrives while the reap timer is overdue is answered, not reset', async (t) => {
  const { accepted, port } = await startServer(t, 100);

  const client = connect(port, '127.0.0.1');
  client.setNoDelay(true);
  t.after(() => client.destroy());
  await new Promise((resolve) => client.once('connect', resolve));

  client.write(request(port));
  assert.match(await nextResponse(client), /^HTTP\/1\.1 200 /, 'the first request is answered');

  // Read the deadline the server actually armed rather than assuming Node's
  // grace period, so this test cannot pass by blocking for less time than the
  // reap needs and never reaching the race at all.
  const [served] = accepted;
  const deadline = served.timeout;
  assert.ok(deadline > 0, 'the server must arm a keep-alive reap, or this test proves nothing');

  // Send the second request and block the loop past the deadline in the same
  // turn: the bytes reach the server's receive queue, the reap timer becomes
  // overdue, and the timers phase gets to run before the poll phase reads them.
  client.write(request(port));
  const start = Date.now();
  while (Date.now() - start < deadline + 200) { /* block: no timers, no poll */ }

  assert.match(
    await nextResponse(client),
    /^HTTP\/1\.1 200 /,
    'a request already in the receive queue must be served, not reset by the keep-alive reap',
  );
});

test('a connection that stays idle past the reap deadline is still closed', async (t) => {
  const { accepted, port } = await startServer(t, 100);

  const client = connect(port, '127.0.0.1');
  client.setNoDelay(true);
  t.after(() => client.destroy());
  await new Promise((resolve) => client.once('connect', resolve));

  client.write(request(port));
  assert.match(await nextResponse(client), /^HTTP\/1\.1 200 /);

  const [served] = accepted;
  const closed = new Promise((resolve) => served.once('close', () => resolve(true)));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), served.timeout + 2000));
  assert.equal(await Promise.race([closed, timedOut]), true,
    'an idle keep-alive connection must still be reaped, or the fix has simply disabled reaping');
});
