// @ts-check

/**
 * **The customer card as a phone-readable page.**
 *
 * One self-contained HTML document: no external stylesheet, script, font or
 * image, so it opens on a phone straight from the device with no network
 * beyond the host serving it. Big tap targets, `tel:` and `mailto:` links,
 * and every unavailable field rendered as its reason — the page never shows
 * a blank line where a fact is missing.
 *
 * Pure function of the card: no I/O, no state, no framework dependency.
 */

const SOCIAL_LABELS = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' });

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {string} phone */
function telHref(phone) {
  const dialable = String(phone).replaceAll(/[^\d+]/g, '');
  return `tel:${dialable === '' ? String(phone) : dialable}`;
}

/**
 * @param {any} card the frozen card from `readCustomerCard`
 * @returns {string} a complete HTML document
 */
export function renderCustomerCardHtml(card) {
  const name = escapeHtml(card?.name ?? 'Scheda cliente');
  const statusValue = escapeHtml(card?.status?.value ?? 'contatto');
  const statusReason = escapeHtml(card?.status?.reason ?? '');
  const email = card?.email ?? null;
  const company = card?.company?.name ?? null;

  const phoneBlock = card?.phone?.available === true
    ? `<p class="line big"><a href="${escapeHtml(telHref(card.phone.value))}">${escapeHtml(card.phone.value)}</a></p>`
    : `<p class="line missing">${escapeHtml(card?.phone?.reason ?? 'telefono non disponibile')}</p>`;

  const socialBlock = Array.isArray(card?.socials) && card.socials.length > 0
    ? `<ul class="chips">${card.socials.map((row) => `<li>${escapeHtml(SOCIAL_LABELS[row.system] ?? row.system)}: ${escapeHtml(row.handle)}</li>`).join('')}</ul>`
    : '<p class="line missing">nessun profilo social collegato</p>';

  const packageBlock = card?.activePackage?.available === true
    ? (card.activePackage.active.length > 0
      ? `<ul>${card.activePackage.active.map((item) => `<li><strong>${escapeHtml(item.name ?? item.id)}</strong> — ${escapeHtml(item.status ?? '')}</li>`).join('')}</ul>`
      : `<p class="line">nessun pacchetto attivo (record: ${escapeHtml(card.activePackage.count)})</p>`)
    : `<p class="line missing">${escapeHtml(card?.activePackage?.reason ?? 'pacchetti non disponibili')}</p>`;

  const notesBlock = `<p class="line missing">${escapeHtml(card?.notes?.reason ?? 'note non disponibili')}</p>`;

  const historyBlock = card?.history?.available === true
    ? (card.history.items.length > 0
      ? `<ul class="history">${card.history.items.map((item) => `<li><span class="kind">${escapeHtml(item.section)}</span> ${escapeHtml(item.name ?? item.id)}${item.status ? ` — ${escapeHtml(item.status)}` : ''}</li>`).join('')}</ul>`
      : '<p class="line">nessun contatto registrato</p>')
    : `<p class="line missing">${escapeHtml(card?.history?.reason ?? 'cronologia non disponibile')}</p>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — scheda cliente</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1rem;line-height:1.5;color:#111}
main{max-width:36rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}
.badge{display:inline-block;background:#111;color:#fff;border-radius:999px;padding:.2rem .8rem;font-size:.9rem;margin:.25rem 0 1rem}
section{border-top:1px solid #ddd;padding:.75rem 0}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:.05em;color:#555;margin:0 0 .5rem}
.line{margin:.25rem 0}
.line.big{font-size:1.4rem}
.line.big a{display:inline-block;padding:.6rem 1rem;background:#0a7d2c;color:#fff;border-radius:.6rem;text-decoration:none}
.missing{color:#666;font-style:italic}
.chips{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.5rem}
.chips li{border:1px solid #999;border-radius:999px;padding:.35rem .8rem}
.history{list-style:none;padding:0}
.history li{padding:.4rem 0;border-bottom:1px solid #eee}
.kind{display:inline-block;min-width:7rem;color:#555;font-size:.85rem}
.reason{font-size:.85rem;color:#777}
</style>
</head>
<body>
<main>
<h1>${name}</h1>
${company ? `<p class="line">${escapeHtml(company)}</p>` : ''}
<p class="badge">stato: ${statusValue}</p>
<section><h2>Telefono</h2>${phoneBlock}</section>
<section><h2>Email</h2>${email ? `<p class="line big"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>` : '<p class="line missing">email non disponibile</p>'}</section>
<section><h2>Profili social</h2>${socialBlock}</section>
<section><h2>Pacchetto attivo</h2>${packageBlock}</section>
<section><h2>Note</h2>${notesBlock}</section>
<section><h2>Cronologia contatti</h2>${historyBlock}
<p class="reason">${card?.history?.available === true ? escapeHtml(card.history.reason ?? '') : ''}</p></section>
<section><p class="reason">stato: ${statusReason}</p></section>
</main>
</body>
</html>`;
}
