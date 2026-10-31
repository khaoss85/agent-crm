import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

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
