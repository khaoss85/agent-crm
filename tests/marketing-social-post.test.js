import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proposeSocialPost, reviewSocialPost, approveSocialPost,
  checkPostSpendCap, verifyPublishedPost, SOCIAL_POST_CHANNEL,
} from '../packages/marketing/src/social-post.js';

/**
 * Squadra social posting, prima slice (voce 18e40456): dagli articoli già
 * pubblicati la squadra propone un post Telegram, Dan approva, il tetto di
 * spesa è acceso con costo visibile e il verificatore confronta il post
 * online con la versione approvata.
 */

const ARTICLE = {
  title: 'Nuovo orario serale in palestra',
  text: 'Da lunedì la sala pesi resta aperta fino alle 23.',
  url: 'https://danielepelleri.com/orario-serale',
};

function proposed(overrides = {}) {
  return proposeSocialPost({
    article: ARTICLE, channel: SOCIAL_POST_CHANNEL, costCents: 120, proposedAt: '2026-11-14T20:00:00Z',
    ...overrides,
  });
}

test('la squadra propone un post Telegram da un articolo pubblicato', () => {
  const post = proposed();
  assert.equal(post.channel, 'telegram');
  assert.equal(post.status, 'proposed');
  assert.equal(post.text, ARTICLE.text);
  assert.equal(post.articleUrl, ARTICLE.url);
  assert.equal(post.costCents, 120);
  assert.ok(Object.isFrozen(post));
});

test('la proposta rifiuta un canale diverso da Telegram', () => {
  assert.throws(() => proposed({ channel: 'email' }), (error) => error.code === 'SOCIAL_POST_INVALID');
});

test('la proposta rifiuta testo e url mancanti', () => {
  assert.throws(() => proposeSocialPost({ article: {}, channel: 'telegram', costCents: 0, proposedAt: '2026-11-14T20:00:00Z' }), (error) => error.code === 'SOCIAL_POST_INVALID');
  const review = reviewSocialPost({ text: '', articleUrl: '', channel: 'telegram' });
  assert.equal(review.complete, false);
  assert.deepEqual([...review.missing], ['text', 'articleUrl', 'costCents']);
});

test("solo un umano approva: la squadra non si dà l'ok da sola", () => {
  const post = proposed();
  assert.throws(() => approveSocialPost({ post, actor: { type: 'agent' }, approvedAt: '2026-11-14T21:00:00Z' }), (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');
});

test("l'ok riesce e congela la versione approvata", () => {
  const post = proposed();
  const { approval, postPatch } = approveSocialPost({ post, actor: { type: 'user', id: 'dan' }, approvedAt: '2026-11-14T21:00:00Z' });
  assert.equal(approval.text, ARTICLE.text);
  assert.equal(approval.approvedBy, 'dan');
  assert.equal(postPatch.status, 'approved');
  assert.throws(() => approveSocialPost({ post: { ...post, status: 'approved' }, actor: { type: 'user' }, approvedAt: '2026-11-14T21:00:00Z' }), (error) => error.code === 'SOCIAL_POST_STATE_INVALID');
});

test('il tetto di spesa è acceso e il costo resta visibile', () => {
  const within = checkPostSpendCap({ spentCents: 800, costCents: 120, capCents: 1000 });
  assert.equal(within.allowed, true);
  assert.equal(within.remainingCents, 200);
  assert.equal(within.costCents, 120);
  const over = checkPostSpendCap({ spentCents: 950, costCents: 120, capCents: 1000 });
  assert.equal(over.allowed, false);
  assert.throws(() => checkPostSpendCap({ spentCents: 0, costCents: 120 }), (error) => error.code === 'SOCIAL_POST_CAP_MISSING');
});

test('il denaro è in centesimi interi, mai in decimali', () => {
  assert.throws(() => proposed({ costCents: 1.2 }), (error) => error.code === 'SOCIAL_POST_INVALID');
});

test('il post online uguale alla versione approvata passa', () => {
  const result = verifyPublishedPost({ approvedText: ARTICLE.text, onlineText: ARTICLE.text });
  assert.equal(result.match, true);
  assert.deepEqual([...result.mismatches], []);
});

test('il post online diverso dalla versione approvata non passa', () => {
  const changed = verifyPublishedPost({ approvedText: ARTICLE.text, onlineText: 'Da lunedì chiusi alle 18.' });
  assert.equal(changed.match, false);
  assert.ok(changed.mismatches.includes('text-differs'));
  const missing = verifyPublishedPost({ approvedText: ARTICLE.text, onlineText: '' });
  assert.equal(missing.match, false);
  assert.ok(missing.mismatches.includes('online-missing'));
});
