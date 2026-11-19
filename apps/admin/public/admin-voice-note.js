// @ts-check
/**
 * Voce 8f1dbd7a3c5e («Detta nota vocale»): what the panel says about the
 * microphone and about the dictation engine.
 *
 * The panel dictates through the browser's own speech recognition
 * (`SpeechRecognition` / `webkitSpeechRecognition`). That engine is not
 * on-device: the browser sends the audio to its vendor's servers for
 * transcription and hands the page only text. This file holds the true
 * privacy line and the microphone help (denied vs missing, with how to
 * enable it or type instead), so the panel never promises the audio stays
 * on the device.
 *
 * Pure and import-free on purpose: the /bo shell cannot import packages.
 */

/**
 * The true privacy line for the dictation engine (voce 8f1dbd7a3c5e): the
 * browser transcribes through its vendor's servers, the CRM never records
 * audio, and nothing is kept until «Salva in cronologia».
 */
export const VOICE_DICTATION_PRIVACY_TEXT =
  'Il dettato usa il riconoscimento vocale del browser: l’audio va ai server del fornitore del browser per diventare testo. ' +
  'Questo gestionale non registra l’audio: riceve solo il testo e lo salva solo se premi «Salva in cronologia».';

/** Microphone blocked by the browser or the device (voce 8f1dbd7a3c5e): how to enable it, or type instead. */
export const VOICE_DICTATION_DENIED_TEXT =
  'Microfono bloccato: consenti il microfono per questo sito nelle impostazioni del browser e nei permessi del dispositivo, poi ricarica. Oppure scrivi qui sotto.';

/** No microphone found or readable on this device (voce 8f1dbd7a3c5e): check it, or type instead. */
export const VOICE_DICTATION_NO_MIC_TEXT =
  'Nessun microfono disponibile: controlla che sia collegato e non usato da un’altra app. Oppure scrivi qui sotto.';

/** The transcription service cannot be reached (voce 8f1dbd7a3c5e): retry, or type instead. */
export const VOICE_DICTATION_NETWORK_TEXT =
  'Il servizio di dettato non risponde: riprova tra poco, oppure scrivi qui sotto.';

/** The dictation did not start for any other reason (voce 8f1dbd7a3c5e): the field stays the way forward. */
export const VOICE_DICTATION_FALLBACK_TEXT =
  'Il dettato non è partito: scrivi qui sotto.';

const DENIED_NAMES = new Set([
  'not-allowed',
  'service-not-allowed',
  'NotAllowedError',
  'SecurityError',
  'PermissionDeniedError',
]);

const NO_MIC_NAMES = new Set([
  'audio-capture',
  'NotFoundError',
  'OverconstrainedError',
  'NotReadableError',
  'DevicesNotFoundError',
]);

const NETWORK_NAMES = new Set(['network', 'NetworkError']);

/**
 * Which microphone help the panel shows for a dictation failure (voce
 * 8f1dbd7a3c5e): denied names how to enable it, a missing device says so,
 * an unreachable service says to retry — every line ends with typing the
 * text instead. Accepts a SpeechRecognition error event (`{ error }`), a
 * DOMException (`{ name }`) or the bare error name.
 * @param {unknown} error
 */
export function dictateMicrophoneHelp(error) {
  const name = typeof error === 'string'
    ? error
    : error !== null && typeof error === 'object'
      ? String(/** @type {any} */ (error).error ?? /** @type {any} */ (error).name ?? '')
      : '';
  if (DENIED_NAMES.has(name)) return VOICE_DICTATION_DENIED_TEXT;
  if (NO_MIC_NAMES.has(name)) return VOICE_DICTATION_NO_MIC_TEXT;
  if (NETWORK_NAMES.has(name)) return VOICE_DICTATION_NETWORK_TEXT;
  return VOICE_DICTATION_FALLBACK_TEXT;
}
