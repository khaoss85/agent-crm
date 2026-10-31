import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';
import { decideIdentityLinkStep } from '../packages/customer-data/src/operations.js';

/**
 * **Manual channel identity link/unlink (backlog:826e377c).**
 *
 * The Collega/Scollega buttons under Identità collegate on the scheda
 * cliente: an operator records an observed number, handle or address as a
 * held `external-identity` (link), or retires a held one to `superseded`
 * without deleting the observation (unlink).
 *
 * What it must prove: link records an observed handle as a held identity
 * with manual-link provenance (the operator's write, not a sender or import
 * run) and replays on a repeat; unlink hides the identity from the profile,
 * the card and the list while keeping the row; a handle held by another
 * customer refuses with IDENTITY_HELD_ELSEWHERE and is never touched;
 * unknown or foreign handles unlink as NOT_FOUND; malformed requests and
 * ghost subjects refuse fail-closed before anything is read or written.
 */

const ACTOR = { type: 'user', id: 'operator' };

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

async function adaByEmail(app) {
  // Ada writes from the form carrying only her email: the sender resolution
  // creates her contact and holds the email identity, nothing else.
  const resolved = await app.resolveChannelSender({
    channel: 'email', handle: 'ada.rossi@example.it',
    firstName: 'Ada', lastName: 'Rossi', actor: ACTOR,
  });
  assert.equal(resolved.outcome, 'created');
  return resolved.contact;
}

function activeIdentities(app, contactId) {
  return app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
}

test('link records an observed WhatsApp number and an Instagram handle, then replays', async (t) => {
  const { app } = await scene(t, 'identity-link-basic');
  const ada = await adaByEmail(app);

  const wa = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });
  assert.equal(wa.outcome, 'linked');
  assert.equal(wa.replayed, false);
  // The stored form is the sender's normalization (separators stripped), so a
  // manual link of an observed handle meets the automatic row.
  assert.equal(wa.sourceKey, 'whatsapp:+39000000001');
  assert.equal(wa.externalId, '+39000000001');
  const waRow = (await activeIdentities(app, ada.id))
    .find((row) => row.sourceKey === 'whatsapp:+39000000001');
  assert.equal(waRow.firstObservedRunId, 'manual-link', 'the link carries manual provenance, not a sender run');
  assert.equal(waRow.lastObservedRunId, 'manual-link', 'the link carries manual provenance, not an import run');

  const ig = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@ada-rossi.esempio', actor: ACTOR,
  });
  assert.equal(ig.outcome, 'linked');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: ada.id });
  assert.deepEqual(
    profile.externalIdentities.map((identity) => identity.system).sort(),
    ['email', 'instagram', 'whatsapp'],
    'the scheda lists the number and the handle beside the email',
  );

  const replay = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });
  assert.equal(replay.outcome, 'already-linked');
  assert.equal(replay.replayed, true);
  assert.equal((await activeIdentities(app, ada.id)).length, 3, 'a repeat links no second row');
});

test('unlink supersedes the held row and a re-link reactivates the same row', async (t) => {
  const { app } = await scene(t, 'identity-unlink-relink');
  const ada = await adaByEmail(app);
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@ada-rossi.esempio', actor: ACTOR,
  });

  const unlinked = await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@ada-rossi.esempio', actor: ACTOR,
  });
  assert.equal(unlinked.outcome, 'unlinked');

  assert.equal((await activeIdentities(app, ada.id)).length, 1, 'only the email identity stays active');
  const retired = await app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'instagram:@ada-rossi.esempio' });
  assert.equal(retired.length, 1, 'the observation is kept, not deleted');
  assert.equal(retired[0].status, 'superseded');
  const profile = await app.readCustomerProfile({ resource: 'contact', id: ada.id });
  assert.ok(
    profile.externalIdentities.every((identity) => identity.system !== 'instagram'),
    'the profile stops reading the unlinked handle',
  );

  const relinked = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@ada-rossi.esempio', actor: ACTOR,
  });
  assert.equal(relinked.outcome, 'linked');
  assert.equal(relinked.reactivated, true);
  assert.equal((await activeIdentities(app, ada.id)).length, 2, 'the same row is active again, no second row');
});

test('a handle held by another customer refuses and is never touched', async (t) => {
  const { app } = await scene(t, 'identity-held-elsewhere');
  const ada = await adaByEmail(app);
  const bianca = await app.resolveChannelSender({
    channel: 'email', handle: 'bianca@example.it',
    firstName: 'Bianca', lastName: 'Verdi', actor: ACTOR,
  });
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });

  await assert.rejects(
    app.linkCustomerIdentity({
      resource: 'contact', id: bianca.contact.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    }),
    (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
    'linking another customer handle refuses with its code',
  );
  const adaRows = await activeIdentities(app, ada.id);
  assert.equal(adaRows.length, 2, "Ada's rows are untouched");
  assert.equal((await activeIdentities(app, bianca.contact.id)).length, 1, 'nothing was recorded for Bianca');
});

test('a released handle re-links to the customer that claims it', async (t) => {
  const { app } = await scene(t, 'identity-link-reclaim');
  const ada = await adaByEmail(app);
  const bianca = await app.resolveChannelSender({
    channel: 'email', handle: 'bianca@example.it',
    firstName: 'Bianca', lastName: 'Verdi', actor: ACTOR,
  });
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });
  await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });

  // Ada released the recycled number: Bianca, its real owner, claims it and
  // the same superseded row re-points at her instead of refusing forever.
  const reclaimed = await app.linkCustomerIdentity({
    resource: 'contact', id: bianca.contact.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });
  assert.equal(reclaimed.outcome, 'linked');
  assert.equal(reclaimed.reactivated, true, 'the released row is reused, never doubled');
  const rows = await app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'whatsapp:+39000000001' });
  assert.equal(rows.length, 1, 'no second row was written');
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].subjectId, bianca.contact.id, 'the row now names the claiming customer');
  assert.equal((await activeIdentities(app, ada.id)).length, 1, 'Ada keeps only her email identity');
  const profile = await app.readCustomerProfile({ resource: 'contact', id: bianca.contact.id });
  assert.ok(
    profile.externalIdentities.some((identity) => identity.system === 'whatsapp'),
    "Bianca's card lists the reclaimed number",
  );
});

test('unlink of an unknown or foreign handle answers not-found', async (t) => {
  const { app } = await scene(t, 'identity-unlink-missing');
  const ada = await adaByEmail(app);
  const bianca = await app.resolveChannelSender({
    channel: 'email', handle: 'bianca@example.it',
    firstName: 'Bianca', lastName: 'Verdi', actor: ACTOR,
  });
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });

  await assert.rejects(
    app.unlinkCustomerIdentity({
      resource: 'contact', id: ada.id, system: 'instagram', externalId: '@mai-visto', actor: ACTOR,
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'an unknown handle unlinks as not-found',
  );
  await assert.rejects(
    app.unlinkCustomerIdentity({
      resource: 'contact', id: bianca.contact.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    "Ada's handle does not unlink from Bianca's card",
  );
  await assert.rejects(
    app.unlinkCustomerIdentity({
      resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    }).then(() => app.unlinkCustomerIdentity({
      resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    })),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'the second unlink of the same handle is not-found, not a silent success',
  );
});

test('decideIdentityLinkStep: the link table both rounds share', (t) => {
  // NOT_GENERAL (backlog:826e377c): the round-1 reclaim cases and the
  // round-2 stale-snapshot case run through this one function, on the row
  // as read inside the committing transaction. There is no stale-snapshot
  // parameter: a snapshot taken before a concurrent reclaim committed
  // cannot reach the decision, so the last row below — fresh active row
  // held elsewhere after an earlier read saw it superseded — refuses.
  const ada = { resource: 'contact', id: 'ada' };
  const bianca = { resource: 'contact', id: 'bianca' };
  const row = (overrides) => ({
    subjectResource: 'contact', subjectId: 'ada', status: 'active', ...overrides,
  });
  assert.equal(decideIdentityLinkStep(null, ada, 'whatsapp'), 'create');
  assert.equal(decideIdentityLinkStep(row({}), ada, 'whatsapp'), 'already-linked');
  assert.equal(decideIdentityLinkStep(row({ status: 'superseded' }), ada, 'whatsapp'), 'reactivate');
  assert.equal(
    decideIdentityLinkStep(row({ status: 'superseded' }), bianca, 'whatsapp'),
    'reactivate',
    'a released handle re-points at the claiming customer (round-1 reclaim)',
  );
  t.diagnostic('stale superseded snapshot, fresh active row held elsewhere');
  assert.throws(
    () => decideIdentityLinkStep(row({}), bianca, 'whatsapp'),
    (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
    'the fresh row decides: a late link loses, never overwrites (round 2)',
  );
  assert.throws(
    () => decideIdentityLinkStep(row({}), { resource: 'company', id: 'ada' }, 'whatsapp'),
    (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
    'same id on another resource is still elsewhere',
  );
});

test('link decisions: one source of truth across every round', async (t) => {
  // NOT_GENERAL (backlog:826e377c): the round-1 reclaim finding and the
  // round-2 stale-snapshot finding share one decision — which stored state
  // lets a link land. Every row below decides on the row as stored when the
  // link commits, and the race case pins that a snapshot captured before a
  // concurrent reclaim never decides.
  const { app } = await scene(t, 'identity-link-table');
  const ada = await adaByEmail(app);
  const bianca = (await app.resolveChannelSender({
    channel: 'email', handle: 'bianca@example.it',
    firstName: 'Bianca', lastName: 'Verdi', actor: ACTOR,
  })).contact;
  const carlo = (await app.resolveChannelSender({
    channel: 'email', handle: 'carlo@example.it',
    firstName: 'Carlo', lastName: 'Neri', actor: ACTOR,
  })).contact;
  const identities = () => app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact' });

  // Absent row: a fresh handle creates one held row.
  const created = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  assert.equal(created.outcome, 'linked');
  assert.equal(created.reactivated, false);

  // Active row held here: a repeat replays, never a second row.
  const replay = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  assert.equal(replay.outcome, 'already-linked');
  assert.equal(replay.replayed, true);

  // Active row held elsewhere: 409 and nobody's rows move (round 1).
  await assert.rejects(
    app.linkCustomerIdentity({
      resource: 'contact', id: bianca.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
    }),
    (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
  );

  // Superseded row, same subject: unlink then relink reactivates the row.
  await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  const healed = await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  assert.equal(healed.outcome, 'linked');
  assert.equal(healed.reactivated, true);

  // Superseded row, other subject: a released handle re-points at the
  // claiming customer instead of refusing forever (round 1 reclaim).
  await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  const reclaimed = await app.linkCustomerIdentity({
    resource: 'contact', id: bianca.id, system: 'whatsapp', externalId: '+39 000 000 010', actor: ACTOR,
  });
  assert.equal(reclaimed.outcome, 'linked');
  assert.equal(reclaimed.reactivated, true);

  // Fresh decision after a completed reclaim (round 2): Carlo holds the
  // recycled handle now, so Bianca's late link refuses and Carlo's row is
  // untouched — whatever Bianca saw before Carlo committed.
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@numero-riciclato', actor: ACTOR,
  });
  await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'instagram', externalId: '@numero-riciclato', actor: ACTOR,
  });
  await app.linkCustomerIdentity({
    resource: 'contact', id: carlo.id, system: 'instagram', externalId: '@numero-riciclato', actor: ACTOR,
  });
  await assert.rejects(
    app.linkCustomerIdentity({
      resource: 'contact', id: bianca.id, system: 'instagram', externalId: '@numero-riciclato', actor: ACTOR,
    }),
    (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
  );
  const rows = await app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'instagram:@numero-riciclato' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].subjectId, carlo.id);
  assert.equal((await identities()).filter((row) => row.sourceKey === 'whatsapp:+39000000010').length, 1);
});

test('a reclaim that commits mid-link loses with 409 instead of overwriting the winner', async (t) => {
  // The round-2 P1 shape: X captures the released (superseded) row before
  // Y's reclaim commits, then X's write must still refuse on the fresh row
  // instead of re-pointing the now-active winner to X.
  const { app, root } = await scene(t, 'identity-link-race');
  const ada = await adaByEmail(app);
  const carlo = (await app.resolveChannelSender({
    channel: 'email', handle: 'carlo@example.it',
    firstName: 'Carlo', lastName: 'Neri', actor: ACTOR,
  })).contact;
  const bianca = (await app.resolveChannelSender({
    channel: 'email', handle: 'bianca@example.it',
    firstName: 'Bianca', lastName: 'Verdi', actor: ACTOR,
  })).contact;
  await app.linkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });
  await app.unlinkCustomerIdentity({
    resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
  });

  // Two connections on the same file: X reads the released row, then its
  // read resolves only after Y's reclaim has committed — so X's write can
  // only decide on a snapshot taken before the winner existed.
  const { app: appY, close: closeY } = await boot(root, join(root, 'data', 'identity-link-race.sqlite'));
  t.after(() => closeY());
  const service = app.modules.get('external-identity').service;
  const originalListWhere = service.listWhere.bind(service);
  let releaseX;
  const gate = new Promise((resolve) => { releaseX = resolve; });
  let reads = 0;
  service.listWhere = async (filters) => {
    reads += 1;
    const pending = originalListWhere(filters);
    if (reads === 1) await gate;
    return pending;
  };
  let yOutcome;
  try {
    const xLink = app.linkCustomerIdentity({
      resource: 'contact', id: bianca.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    });
    for (let waited = 0; reads === 0 && waited < 2000; waited += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    assert.equal(reads, 1, 'X is parked inside its pre-commit read');
    // Y starts while X is parked and blocks on the write lock until X's
    // transaction releases it; whichever reclaim commits first wins.
    const yLink = appY.linkCustomerIdentity({
      resource: 'contact', id: carlo.id, system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    });
    releaseX();
    yOutcome = await yLink.then(
      (won) => ({ won, lost: null }),
      (lost) => ({ won: null, lost }),
    );
    if (yOutcome.won) {
      assert.equal(yOutcome.won.outcome, 'linked', 'the first reclaim to commit wins');
      await assert.rejects(
        xLink,
        (error) => error.code === 'IDENTITY_HELD_ELSEWHERE' && error.status === 409,
        'the late link refuses on the fresh row instead of overwriting the winner',
      );
    } else {
      assert.equal(yOutcome.lost?.code, 'IDENTITY_HELD_ELSEWHERE');
      assert.equal(yOutcome.lost?.status, 409);
      assert.equal((await xLink).outcome, 'linked', 'the first beginner wins');
    }
  } finally {
    service.listWhere = originalListWhere;
  }

  const rows = await app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'whatsapp:+39000000001' });
  assert.equal(rows.length, 1, 'no second row was written');
  assert.equal(rows[0].status, 'active');
  const winnerId = yOutcome.won ? carlo.id : bianca.id;
  assert.equal(rows[0].subjectId, winnerId, 'the row still names the winner');
});

test('malformed requests and ghost subjects refuse before anything is read or written', async (t) => {
  const { app } = await scene(t, 'identity-link-validation');
  const ada = await adaByEmail(app);
  const before = (await activeIdentities(app, ada.id)).length;
  for (const bad of [
    { resource: 'contact', id: '', system: 'whatsapp', externalId: '+39 000 000 001' },
    { resource: 'ordine', id: ada.id, system: 'whatsapp', externalId: '+39 000 000 001' },
    { resource: 'contact', id: ada.id, system: 'piccioni', externalId: 'x' },
    { resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '   ' },
    { resource: 'contact', id: ada.id, system: 'whatsapp', externalId: '---' },
    { resource: 'contact', id: ada.id, system: 'email', externalId: 'non-un-indirizzo' },
  ]) {
    await assert.rejects(
      app.linkCustomerIdentity({ ...bad, actor: ACTOR }),
      (error) => error.status === 400,
      `link refuses ${JSON.stringify(bad)}`,
    );
    await assert.rejects(
      app.unlinkCustomerIdentity({ ...bad, actor: ACTOR }),
      (error) => error.status === 400,
      `unlink refuses ${JSON.stringify(bad)}`,
    );
  }
  await assert.rejects(
    app.linkCustomerIdentity({
      resource: 'contact', id: 'contatto-fantasma', system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'a link for a ghost record answers not-found, never a held identity pointing at nobody',
  );
  await assert.rejects(
    app.unlinkCustomerIdentity({
      resource: 'contact', id: 'contatto-fantasma', system: 'whatsapp', externalId: '+39 000 000 001', actor: ACTOR,
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'an unlink for a ghost record answers not-found',
  );
  assert.equal((await activeIdentities(app, ada.id)).length, before, 'every refusal wrote nothing');
});
