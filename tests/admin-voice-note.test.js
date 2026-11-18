import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_DICTATION_DENIED_TEXT,
  VOICE_DICTATION_FALLBACK_TEXT,
  VOICE_DICTATION_NETWORK_TEXT,
  VOICE_DICTATION_NO_MIC_TEXT,
  VOICE_DICTATION_PRIVACY_TEXT,
  dictateMicrophoneHelp,
} from '../apps/admin/public/admin-voice-note.js';

/**
 * Voce 8f1dbd7a3c5e («Detta nota vocale»): microphone denied/unavailable
 * explained with how to enable it or type instead, and the true privacy
 * line for the dictation engine.
 */

test('8f1dbd7a3c5e: the privacy line tells the true engine — vendor servers, no audio kept', () => {
  assert.ok(VOICE_DICTATION_PRIVACY_TEXT.includes('server del fornitore del browser'));
  assert.ok(VOICE_DICTATION_PRIVACY_TEXT.includes('non registra l’audio'));
  assert.ok(VOICE_DICTATION_PRIVACY_TEXT.includes('solo se premi «Salva in cronologia»'));
  assert.ok(
    !VOICE_DICTATION_PRIVACY_TEXT.includes('non lascia mai il dispositivo'),
    'never promises the audio stays on the device',
  );
});

test('8f1dbd7a3c5e: a blocked microphone explains how to enable it or type instead', () => {
  for (const error of [
    'not-allowed',
    'service-not-allowed',
    'NotAllowedError',
    'SecurityError',
    { error: 'not-allowed' },
    { name: 'NotAllowedError' },
  ]) {
    assert.equal(dictateMicrophoneHelp(error), VOICE_DICTATION_DENIED_TEXT);
  }
  assert.ok(VOICE_DICTATION_DENIED_TEXT.includes('consenti il microfono'));
  assert.ok(VOICE_DICTATION_DENIED_TEXT.includes('Oppure scrivi qui sotto.'));
});

test('8f1dbd7a3c5e: a missing microphone says so and offers typing', () => {
  for (const error of [
    'audio-capture',
    'NotFoundError',
    'OverconstrainedError',
    { error: 'audio-capture' },
    { name: 'NotFoundError' },
  ]) {
    assert.equal(dictateMicrophoneHelp(error), VOICE_DICTATION_NO_MIC_TEXT);
  }
  assert.ok(VOICE_DICTATION_NO_MIC_TEXT.includes('Nessun microfono disponibile'));
  assert.ok(VOICE_DICTATION_NO_MIC_TEXT.includes('Oppure scrivi qui sotto.'));
});

test('8f1dbd7a3c5e: an unreachable service says to retry or type, anything else falls back to typing', () => {
  assert.equal(dictateMicrophoneHelp('network'), VOICE_DICTATION_NETWORK_TEXT);
  assert.equal(dictateMicrophoneHelp({ error: 'network' }), VOICE_DICTATION_NETWORK_TEXT);
  for (const error of [undefined, null, {}, '', 'no-speech', 'aborted', { name: 'UnknownError' }]) {
    assert.equal(dictateMicrophoneHelp(error), VOICE_DICTATION_FALLBACK_TEXT, JSON.stringify(error));
  }
  assert.equal(VOICE_DICTATION_FALLBACK_TEXT, 'Il dettato non è partito: scrivi qui sotto.');
});
