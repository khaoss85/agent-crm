import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:fd0adcded1c3 (seguito di 23f92c6a72ea), sempre eseguito: la fast
 * non ha Chromium, quindi admin-pipeline-panel-room-browser.test.js lì salta
 * (log della fast di #869). Qui la stessa prova senza browser, con le misure
 * prese dal Chromium vero sulla pagina di bo:shots: board da x 296, colonne
 * da 168 px a 1024 e da 181 px a 1280, 12 px fra l'una e l'altra, pannello
 * di 420 px a 24 px dal bordo destro. Aprendo la card di Proposta e quella
 * di Pagato, la loro colonna deve finire prima del pannello.
 */

const STAGES = [
  { key: 'richiesta-info', label: 'Richiesta info', order: 10, type: 'open', probability: 10 },
  { key: 'prova', label: 'Prova', order: 20, type: 'open', probability: 30 },
  { key: 'proposta', label: 'Proposta', order: 30, type: 'open', probability: 60 },
  { key: 'pagato', label: 'Pagato', order: 40, type: 'won', probability: 100 },
  { key: 'perso', label: 'Perso', order: 50, type: 'lost', probability: 0 },
];
const PIPELINE = { pipelineContract: 1, name: 'accordo-sales', label: 'Vendite', module: 'opportunity', defaultStage: 'richiesta-info', stages: STAGES };
const RECORDS = [
  { id: 'c', name: 'Deal estero', companyName: 'Gym Intl', valueCents: 2500, currency: 'USD', pipelineKey: 'accordo-sales', pipelineStage: 'proposta' },
  { id: 'd', name: 'Cliente vinto', companyName: 'Fit Club', valueCents: 9900, currency: 'EUR', pipelineKey: 'accordo-sales', pipelineStage: 'pagato' },
];

const BOARD_LEFT = 296;
const GAP = 12;

/** A fake document whose board, columns and panel measure like the real page at `width`. */
function measuredDocument(width, columnWidth) {
  const doc = createFakeDocument();
  const make = doc.createElement;
  let board = null;
  doc.createElement = (tag) => {
    const node = make(tag);
    node.getBoundingClientRect = () => {
      const cls = String(node.getAttribute('class') ?? '');
      if (node.getAttribute('data-offer-drawer') !== null) {
        const left = width - 24 - 420;
        return { left, right: left + 420, width: 420, top: 72, height: 600 };
      }
      if (cls.split(/\s+/).includes('pipeline-board')) {
        board = node;
        return { left: BOARD_LEFT, right: width - 24, width: width - 24 - BOARD_LEFT, top: 480, height: 300 };
      }
      const stage = node.getAttribute('data-stage');
      if (stage !== null) {
        const at = STAGES.findIndex((item) => item.key === stage);
        const left = BOARD_LEFT + at * (columnWidth + GAP) - Number(board?.scrollLeft ?? 0);
        return { left, right: left + columnWidth, width: columnWidth, top: 480, height: 300 };
      }
      return { left: 0, right: 0, width: 0, top: 0, height: 0 };
    };
    return node;
  };
  return doc;
}

const client = {
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
    if (path === '/api/spine/memberships') return { items: [] };
    return { items: RECORDS };
  },
};

const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));

for (const [width, columnWidth] of [[1024, 168], [1280, 181]]) {
  test(`fd0adcded1c3: at ${width} px the open card's column ends before the offer panel (no browser needed)`, async () => {
    for (const [id, stage] of [['c', 'proposta'], ['d', 'pagato']]) {
      const doc = measuredDocument(width, columnWidth);
      const mount = createMount();
      const view = createPipelineBoard({ doc, mount, client, toast: () => {}, navigate: () => {}, wait: () => new Promise(() => {}) });
      await view.renderBoard('accordo-sales');
      const card = cardOf(mount, id);
      card.findAll('button').find((n) => n.getAttribute('data-action') === 'open-offer').dispatch('click');
      const panel = mount.findAll('div').find((n) => n.getAttribute('data-offer-drawer') !== null);
      assert.ok(panel, `${width} ${stage}: the panel is open`);
      const column = card.parentNode;
      const board = column.parentNode;
      const box = column.getBoundingClientRect();
      const sheet = panel.getBoundingClientRect();
      assert.equal(column.getAttribute('data-stage'), stage);
      assert.ok(box.right <= sheet.left,
        `${width} ${stage}: the column (x ${box.left}-${box.right}) ends before the panel (x ${sheet.left}-${sheet.right})`);
      assert.ok(box.left >= BOARD_LEFT, `${width} ${stage}: and starts inside the board (${box.left})`);
      assert.equal(board.getAttribute('data-offer-room'), 'true', 'the board holds room for the panel');
      assert.match(String(board.getAttribute('style')), new RegExp(`--pipeline-column-width: ${columnWidth}px`), 'the columns keep their width');
      panel.findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click', { detail: 0 });
      assert.equal(board.getAttribute('data-offer-room'), null, 'closing gives the board its width back');
    }
  });
}
