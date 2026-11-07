import test from 'node:test';
import assert from 'node:assert/strict';
import { coalescedProfileFor } from '../packages/customer-data/src/profile.js';
import { resolvedNames } from '../packages/customer-data/src/store.js';

/**
 * Voce 908f2eb9bbfb (follow-up al 503): una scheda apre tre letture che
 * calcolano tutte lo stesso profilo (card, timeline, profilo diretto) nello
 * stesso istante. Senza condivisione sono tre calcoli completi in parallelo
 * sullo stesso pool, ed è così che nasceva il 503 intermittente. Le letture
 * concorrenti per lo stesso soggetto condividono il calcolo in volo — mai
 * una cache oltre il calcolo, mai un errore che resta appeso.
 */

const managed = (service) => ({ service: { createManaged() {}, ...service } });

function stubModules({ links, onLinkQuery } = {}) {
  const emptyQuery = async () => [];
  const linkQuery = async (filters) => {
    onLinkQuery?.(filters);
    return links ?? [];
  };
  return new Map([
    ['canonical-link', managed({ listWhere: linkQuery })],
    ['external-identity', managed({ listWhere: emptyQuery })],
    ['data-quality-issue', managed({ listWhere: emptyQuery })],
    ['duplicate-candidate', managed({ listWhere: emptyQuery })],
  ]);
}

const SUBJECT = { resource: 'contact', id: 'c1' };

function read(modules, subject = SUBJECT) {
  return coalescedProfileFor({ modules, core: null, names: resolvedNames(), subject });
}

test('voce 908f2eb9bbfb: concurrent reads of one subject share one computation', async () => {
  let linkQueries = 0;
  const modules = stubModules({ onLinkQuery: () => { linkQueries += 1; } });
  const [first, second, third] = await Promise.all([read(modules), read(modules), read(modules)]);
  assert.equal(linkQueries, 1, 'one computation, not three side-by-side ones');
  assert.strictEqual(second, first, 'the concurrent reads share the same frozen profile');
  assert.strictEqual(third, first, 'the third sharer too');
});

test('voce 908f2eb9bbfb: reads for different subjects never share', async () => {
  let linkQueries = 0;
  const modules = stubModules({ onLinkQuery: () => { linkQueries += 1; } });
  const [one, two] = await Promise.all([
    read(modules, { resource: 'contact', id: 'c1' }),
    read(modules, { resource: 'contact', id: 'c2' }),
  ]);
  assert.notStrictEqual(two, one, 'a different subject is a different computation');
  assert.equal(linkQueries, 2, 'one computation per subject');
});

test('voce 908f2eb9bbfb: after the computation settles the next read computes again', async () => {
  let linkQueries = 0;
  const modules = stubModules({ onLinkQuery: () => { linkQueries += 1; } });
  const first = await read(modules);
  const second = await read(modules);
  assert.notStrictEqual(second, first, 'nothing is cached past the computation');
  assert.deepEqual(second, first, 'the fresh computation answers the same profile');
  assert.equal(linkQueries, 2, 'one computation per settled read');
});

test('voce 908f2eb9bbfb: a shared failure clears, the next read retries', async () => {
  let linkQueries = 0;
  let failLinks = true;
  const modules = new Map([
    ['canonical-link', managed({
      listWhere: async () => {
        linkQueries += 1;
        if (failLinks) throw Object.assign(new Error('pool esaurito'), { status: 503 });
        return [];
      },
    })],
    ['external-identity', managed({ listWhere: async () => [] })],
    ['data-quality-issue', managed({ listWhere: async () => [] })],
    ['duplicate-candidate', managed({ listWhere: async () => [] })],
  ]);
  const [left, right] = await Promise.allSettled([read(modules), read(modules)]);
  assert.equal(left.status, 'rejected', 'the first sharer gets the failure');
  assert.equal(right.status, 'rejected', 'the second sharer gets the same failure');
  assert.equal(linkQueries, 1, 'the failing computation ran once, not twice');
  failLinks = false;
  const retry = await read(modules);
  assert.equal(linkQueries, 2, 'the retry computes again instead of replaying the failure');
  assert.equal(retry.customerProfileContract, 1, 'the retry answers a real profile');
});
