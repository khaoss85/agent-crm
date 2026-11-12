// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, eventPopoverPlacement } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Dan 11/11 — il dettaglio di un appuntamento si apre in un popover vicino
 * all'evento, come Google Calendar e Outlook, non più solo nella colonna di
 * sinistra. Il popover è un dialog con nome, prende il focus e lo restituisce
 * all'evento; Esc, clic fuori e × lo chiudono; sta a destra dell'evento, a
 * sinistra se a destra non c'è spazio, mai fuori dallo schermo. Dentro:
 * «Modifica o sposta» (il flusso di spostamento esistente), il titolo con il
 * quadratino colore, giorno con il mese intero, cliente come link alla
 * scheda, persona del team con avatar e nome (mai un id o un handle), nota e
 * origine. «Annulla appuntamento» ha i suoi test in
 * tests/admin-calendario-annulla.test.js.
 */

const ROSTER = [
  // One human, two identities joined by the person key: the profile name
  // («Daniele Pelleri») beats the GitHub handle («khaoss85»).
  { subject: 'github|48571113', role: 'owner', displayName: 'khaoss85', email: 'dan@github.invalid', operatorAccountId: 'op-1' },
  { subject: 'google|1049abc', role: 'owner', displayName: 'Daniele Pelleri', email: 'dan@example.com', operatorAccountId: 'op-1' },
];

const WEEK = () => ({
  from: '2026-11-09T00:00:00.000Z',
  to: '2026-11-16T00:00:00.000Z',
  members: [{
    teamMemberId: 'github|48571113',
    appointments: [
      {
        // Tuesday 10 Nov 10:00–10:45 Rome (09:00Z in winter).
        id: 'p1',
        status: 'booked',
        startsAt: '2026-11-10T09:00:00.000Z',
        endsAt: '2026-11-10T09:45:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'github|48571113',
        notes: 'Portare le scarpe',
        sourceKey: 'calendario:github|48571113:p1:c1',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada Rossi' },
      },
      {
        // Friday 13 Nov, the last column: the popover flips left.
        id: 'p2',
        status: 'booked',
        startsAt: '2026-11-13T15:00:00.000Z',
        endsAt: '2026-11-13T15:30:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'github|48571113',
        sourceKey: 'calendario:github|48571113:p2:c2',
        subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: 'Bea Neri' },
      },
    ],
  }],
});

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function stubClient({ week = WEEK(), roster = ROSTER } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method: options.method ?? 'GET', body });
      if (path === '/api/spine/memberships') {
        if (roster === null) throw notFound();
        return { items: roster };
      }
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      if (path.startsWith('/api/customer-data/customers')) return { items: [] };
      if (path.startsWith('/api/customer-data/profile/')) throw notFound();
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path === '/api/appointments/reschedule') {
        const row = week.members[0].appointments.find((entry) => entry.id === body.id);
        row.startsAt = body.startsAt;
        row.endsAt = body.endsAt;
        return { appointment: { ...row }, moved: true };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fake document that also takes document-level listeners (click, keydown),
 * so a click outside and a stray Esc reach the view like in a browser, and
 * tracks the focused node.
 */
function listeningDocument({ rects = null } = {}) {
  const base = createFakeDocument();
  const listeners = { click: [], keydown: [] };
  const doc = {
    ...base,
    activeElement: null,
    defaultView: rects ? { innerWidth: rects.viewport.width, innerHeight: rects.viewport.height } : undefined,
    createElement(tag) {
      const node = base.createElement(tag);
      const focus = node.focus.bind(node);
      node.focus = () => {
        focus();
        doc.activeElement = node;
      };
      if (rects) node.getBoundingClientRect = () => rects.of(node);
      return node;
    },
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    fire(type, event) {
      for (const handler of listeners[type] ?? []) handler(event);
    },
  };
  return doc;
}

async function openWeek(options = {}) {
  const doc = options.doc ?? listeningDocument();
  const mount = createMount();
  const client = stubClient(options);
  const navigated = [];
  const view = createCalendarioView({
    searchDelayMs: 0,
    doc,
    mount,
    client,
    navigate: (hash) => navigated.push(hash),
    now: () => new Date('2026-11-09T07:00:00Z'),
  });
  await view.render();
  await settle();
  return { doc, mount, client, navigated, view };
}

function eventButton(mount, id) {
  const button = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === id);
  assert.ok(button, `event ${id} paints`);
  return button;
}

function popover(mount) {
  return mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail') ?? null;
}

function click(doc, node, event = {}) {
  node.dispatch('click', { target: node, ...event });
  // The click bubbles to the document, like in a browser.
  doc.fire?.('click', { target: node, ...event });
}

function hasClass(node, name) {
  return (node?.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

test('popover: a click on an event opens a named dialog beside the grid, not in the rail', async () => {
  const { doc, mount } = await openWeek();
  assert.equal(popover(mount), null, 'nothing open before a click');
  click(doc, eventButton(mount, 'p1'));
  const pop = popover(mount);
  assert.ok(pop, 'the click opens the popover');
  assert.equal(pop.getAttribute('role'), 'dialog');
  const labelledBy = pop.getAttribute('aria-labelledby');
  const title = pop.findAll('h2').find((node) => node.getAttribute('id') === labelledBy);
  assert.ok(title, 'the dialog is named by its title');
  assert.match(title.textContent, /Ada Rossi/);
  assert.ok(hasClass(pop, 'cal-pop'), 'the shared calendar popover surface');
  const main = mount.findAll('div').find((node) => hasClass(node, 'cal-main'));
  const rail = mount.findAll('div').find((node) => hasClass(node, 'cal-rail'));
  assert.ok(main.contains(pop), 'the popover sits over the grid');
  assert.ok(!rail.findAll('div').some((node) => node.getAttribute('data-role') === 'event-detail'), 'the rail keeps its own cards only');
  assert.ok(rail.textContent.includes('Fissa con una frase') || rail.findAll('textarea').length > 0, 'the rail still holds the phrase card');
  assert.equal(doc.activeElement, pop, 'focus moves into the popover');
  const block = eventButton(mount, 'p1');
  assert.ok(hasClass(block, 'cal-selected'), 'the event stays highlighted');
  assert.equal(block.getAttribute('aria-pressed'), 'true');
});

test('popover: actions on top, big title with the colour square, full date, customer link, person, note, origin', async () => {
  const { doc, mount, navigated } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  const pop = popover(mount);
  const tools = pop.findAll('div').find((node) => hasClass(node, 'cal-pop-tools'));
  assert.ok(tools, 'the actions row paints on top');
  assert.equal(pop.childNodes[0], tools, 'the actions come first');
  const labels = tools.findAll('button').map((node) => node.getAttribute('aria-label'));
  assert.deepEqual(labels, ['Modifica o sposta', 'Annulla appuntamento', 'Chiudi'], 'edit, cancel (backlog:5346ab531538) and close');
  const title = pop.findAll('h2')[0];
  const swatch = title.findAll('span').find((node) => hasClass(node, 'cal-swatch'));
  assert.ok(swatch, 'the title carries the colour square');
  const tint = (eventButton(mount, 'p1').getAttribute('class') ?? '').split(/\s+/).find((name) => /^cal-m\d$/.test(name));
  assert.ok(hasClass(swatch, tint), `the square has the event colour ${tint}`);
  assert.ok(pop.textContent.includes('Martedì 10 novembre · 10:00–10:45'), pop.textContent);
  const link = pop.findAll('a')[0];
  assert.equal(link.textContent, 'Ada Rossi', 'the customer is a link');
  assert.equal(link.getAttribute('href'), '#/customer-card/contact/c1');
  let prevented = false;
  link.dispatch('click', { preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(navigated, ['#/customer-card/contact/c1'], 'the link opens the scheda');
  const person = pop.findAll('p').find((node) => node.getAttribute('data-role') === 'event-member');
  assert.ok(person, 'the team person paints');
  const gridAvatar = eventButton(mount, 'p1').findAll('span').find((node) => hasClass(node, 'cal-avatar'))?.textContent;
  assert.equal(person.findAll('span').find((node) => hasClass(node, 'cal-avatar'))?.textContent, gridAvatar, 'with the same avatar as the grid block');
  assert.ok(person.textContent.includes('Daniele Pelleri'), 'and the person name');
  assert.ok(pop.textContent.includes('Nota: Portare le scarpe'));
  assert.ok(pop.textContent.includes('Fissato dal calendario'), 'the origin');
});

test('popover: never a technical name — no id, no handle, no pipe subject', async () => {
  const { doc, mount } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  const text = popover(mount).textContent;
  assert.ok(!text.includes('khaoss85'), 'the GitHub handle never paints when the person has a name');
  assert.ok(!text.includes('github|'), 'no pipe subject');
  assert.ok(!text.includes('google|'), 'no pipe subject');
  assert.ok(!text.includes('c1'), 'no customer id');
  // Without a roster nothing names the pipe subject: the person row drops
  // out instead of printing the id.
  const bare = await openWeek({ roster: null });
  const filter = bare.mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'github|48571113';
  bare.mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  click(bare.doc, eventButton(bare.mount, 'p1'));
  const pop = popover(bare.mount);
  assert.ok(pop, 'the popover opens');
  assert.ok(!pop.textContent.includes('github|'), pop.textContent);
  assert.equal(pop.findAll('p').filter((node) => node.getAttribute('data-role') === 'event-member').length, 0);
});

test('popover: Esc closes it and focus returns to the event', async () => {
  const { doc, mount } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  popover(mount).dispatch('keydown', { key: 'Escape' });
  assert.equal(popover(mount), null, 'Esc closes the popover');
  const block = eventButton(mount, 'p1');
  assert.equal(doc.activeElement, block, 'focus is back on the event');
  assert.ok(!hasClass(block, 'cal-selected'), 'the event is no longer selected');
  // Esc from anywhere on the page (focus lost to a repaint) closes it too.
  click(doc, eventButton(mount, 'p1'));
  assert.ok(popover(mount));
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(popover(mount), null, 'a document Esc closes the popover');
});

test('popover: × closes it and focus returns to the event', async () => {
  const { doc, mount } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  const close = popover(mount).findAll('button').find((node) => node.getAttribute('aria-label') === 'Chiudi');
  click(doc, close);
  assert.equal(popover(mount), null);
  assert.equal(doc.activeElement, eventButton(mount, 'p1'));
});

test('popover: a click outside closes it, a click inside or on another event does not', async () => {
  const { doc, mount } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  assert.ok(popover(mount), 'the opening click does not close the popover it opened');
  // A click inside (on the date line) keeps it.
  const when = popover(mount).findAll('p').find((node) => hasClass(node, 'cal-pop-when'));
  click(doc, when);
  assert.ok(popover(mount), 'a click inside keeps the popover');
  // The edit icon repaints the popover: its old node is detached, still inside.
  click(doc, popover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-edit'));
  assert.ok(popover(mount), 'a repainting click inside keeps the popover');
  // Another event switches the popover to it.
  click(doc, eventButton(mount, 'p2'));
  assert.ok(popover(mount)?.textContent.includes('Bea Neri'), 'another event switches the popover');
  // A click into the phrase field closes it and leaves focus in the field:
  // the operator's next keystrokes land where they clicked.
  const phrase = mount.querySelector('textarea[name="phrase"]');
  assert.ok(phrase, 'the rail keeps the phrase field');
  phrase.focus();
  doc.fire('click', { target: phrase });
  assert.equal(popover(mount), null, 'a click outside closes the popover');
  const repainted = mount.querySelector('textarea[name="phrase"]');
  assert.equal(doc.activeElement, repainted, 'focus stays in the field the operator clicked, never pulled to the event');
  // A stray Esc while typing elsewhere leaves focus there as well.
  click(doc, eventButton(mount, 'p1'));
  mount.querySelector('textarea[name="phrase"]').focus();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(popover(mount), null);
  assert.equal(doc.activeElement, mount.querySelector('textarea[name="phrase"]'), 'Esc from another field keeps that field focused');
});

test('popover: a click on «Nuovo appuntamento» closes the popover and still opens its menu (review #773)', async () => {
  const { doc, mount } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  assert.ok(popover(mount));
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  click(doc, toggle);
  assert.equal(popover(mount), null, 'the outside click closes the popover');
  const menu = mount.findAll('div').find((node) => node.getAttribute('role') === 'menu');
  assert.ok(menu && !menu.classList.contains('hidden'), 'the menu the same click opened stays open');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(mount.contains(toggle), 'no repaint replaced the control the operator clicked');
  const block = eventButton(mount, 'p1');
  assert.ok(!hasClass(block, 'cal-selected'), 'the event drops its highlight');
  assert.equal(block.getAttribute('aria-pressed'), 'false');
  // A later click on the same event opens it again.
  click(doc, block);
  assert.ok(popover(mount), 'the event opens again');
});

test('popover: a route away drops the closer, it never repaints the next screen', async () => {
  const { doc, mount, view } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  view.invalidate();
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const other = doc.createElement('div');
  mount.appendChild(other);
  doc.fire('click', { target: other });
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(mount.firstChild, other, 'the next screen stays mounted');
});

test('popover: «Modifica o sposta» opens the existing move form, prefilled, with a wait state', async () => {
  const { doc, mount, client } = await openWeek();
  click(doc, eventButton(mount, 'p1'));
  assert.equal(mount.querySelector('div[data-role="move-form"]'), null, 'the form waits for the edit icon');
  const edit = popover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-edit');
  assert.equal(edit.getAttribute('aria-expanded'), 'false');
  click(doc, edit);
  const pop = popover(mount);
  const form = pop.querySelector('div[data-role="move-form"]');
  assert.ok(form, 'the move form opens inside the popover');
  assert.equal(form.querySelector('input[name="move-date"]').value, '2026-11-10');
  assert.equal(form.querySelector('input[name="move-start"]').value, '10:00');
  assert.equal(form.querySelector('input[name="move-end"]').value, '10:45');
  assert.equal(doc.activeElement, form.querySelector('input[name="move-date"]'), 'focus lands on the first field');
  form.querySelector('input[name="move-start"]').value = '11:00';
  form.querySelector('input[name="move-end"]').value = '11:45';
  form.findAll('button').find((node) => node.getAttribute('data-action') === 'move-submit').dispatch('click');
  // While the write runs the button waits.
  const busy = popover(mount).querySelector('button[data-action="move-submit"]');
  assert.notEqual(busy.getAttribute('disabled'), null, 'no second submit while the move runs');
  assert.equal(busy.getAttribute('aria-busy'), 'true');
  assert.equal(busy.textContent, 'Spostamento in corso…');
  await settle();
  const moves = client.calls.filter((call) => call.path === '/api/appointments/reschedule');
  assert.equal(moves.length, 1, 'the existing reschedule route');
  assert.equal(moves[0].body.id, 'p1');
  const after = popover(mount);
  assert.ok(after, 'the popover stays on the moved event');
  assert.match(after.textContent, /Spostato a Martedì 11:00–11:45/);
  assert.equal(after.querySelector('div[data-role="move-form"]'), null, 'the form folds away after the move');
});

test('placement: right of the event, left when the right has no room, never off screen', () => {
  const box = { left: 300, top: 100 };
  const viewport = { viewportWidth: 1280, viewportHeight: 800 };
  // Room on the right.
  const right = eventPopoverPlacement({ anchor: { left: 400, right: 560, top: 200 }, box, width: 340, height: 300, ...viewport });
  assert.deepEqual(right, { left: 560 + 12 - 300, top: 200 - 100, side: 'right' });
  // Last column: no room on the right, the popover flips left.
  const left = eventPopoverPlacement({ anchor: { left: 1100, right: 1260, top: 200 }, box, width: 340, height: 300, ...viewport });
  assert.equal(left.side, 'left');
  assert.equal(left.left, 1100 - 12 - 340 - 300);
  // A late event near the bottom: the popover lifts to stay on screen.
  const low = eventPopoverPlacement({ anchor: { left: 400, right: 560, top: 700 }, box, width: 340, height: 300, ...viewport });
  assert.equal(low.top + box.top + 300 <= 800 - 8, true, 'the bottom edge stays on screen');
  // A narrow screen with room on neither side: clamped inside the viewport.
  const narrow = eventPopoverPlacement({
    anchor: { left: 100, right: 300, top: 50 }, box: { left: 0, top: 0 }, width: 340, height: 300, viewportWidth: 420, viewportHeight: 700,
  });
  assert.ok(narrow.left >= 8 && narrow.left + 340 <= 420 - 8, `inside the screen: ${narrow.left}`);
  assert.ok(narrow.top >= 8);
});

test('placement: the painted popover is seated by the event rectangle', async () => {
  const columns = { p1: { left: 420, right: 560, top: 240 }, p2: { left: 1110, right: 1250, top: 420 } };
  const rects = {
    viewport: { width: 1280, height: 800 },
    of(node) {
      const id = node.getAttribute('data-event-id');
      if (id && columns[id]) return { ...columns[id], bottom: columns[id].top + 40, width: 140, height: 40 };
      if (hasClass(node, 'cal-main')) return { left: 330, right: 1270, top: 120, bottom: 900, width: 940, height: 780 };
      if (node.getAttribute('data-role') === 'event-detail') return { left: 0, right: 340, top: 0, bottom: 320, width: 340, height: 320 };
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  const { doc, mount } = await openWeek({ doc: listeningDocument({ rects }) });
  click(doc, eventButton(mount, 'p1'));
  let pop = popover(mount);
  assert.equal(pop.getAttribute('data-side'), 'right');
  assert.equal(pop.getAttribute('style'), `left: ${560 + 12 - 330}px; top: ${240 - 120}px`);
  click(doc, eventButton(mount, 'p2'));
  pop = popover(mount);
  assert.equal(pop.getAttribute('data-side'), 'left', 'the last column flips the popover left');
  assert.equal(pop.getAttribute('style'), `left: ${1110 - 12 - 340 - 330}px; top: ${420 - 120}px`);
});
