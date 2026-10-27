// @ts-check

// BO-F6-02 — the component catalog page (`#/componenti`): every element of
// the visual system rendered with demo data, so reviewers and the shots
// harness see the whole language on one screen. Static content only: no
// fetch, no writes, no space needed. Not linked from the sidebar (BO-F6-01
// keeps the sidebar to real modules); reachable by direct route.
import {
  UI_AUTHORITIES,
  UI_CHANNELS,
  el,
  uiBadge,
  uiButton,
  uiCard,
  uiChannelChip,
  uiEmpty,
  uiSearchField,
  uiSection,
  uiSecondaryButton,
  uiSecretField,
  uiSegmented,
  uiSelect,
  uiSwitch,
  uiTable,
  uiTabs,
  uiToast,
} from './admin-ui.js';

/**
 * @param {{ doc: any, mount: any }} deps
 */
export function createUiCatalogView(deps) {
  const { doc, mount } = deps;

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  function heading(title, text) {
    const section = uiSection(doc, { title });
    const lede = el(doc, 'p', 'lede', text);
    section.appendChild(lede);
    return section;
  }

  function renderButtons(box) {
    const section = heading(
      'Pulsanti',
      'Primario scuro per l\u2019azione principale, CTA verde per l\u2019azione che produce l\u2019accordo, secondario per il lavoro ordinario, rifiuto e pericolo per i no.',
    );
    const row = el(doc, 'div', 'actions');
    row.appendChild(uiButton(doc, { variant: 'primary', label: 'Invia follow-up' }));
    row.appendChild(uiButton(doc, { variant: 'cta', label: 'Aggiungi' }));
    row.appendChild(uiSecondaryButton(doc, 'Annulla'));
    row.appendChild(uiButton(doc, { variant: 'refusal', label: 'Rifiuta' }));
    row.appendChild(uiButton(doc, { variant: 'danger', label: 'Elimina' }));
    row.appendChild(uiButton(doc, { variant: 'secondary', label: 'Dettaglio', small: true }));
    const busy = uiButton(doc, { variant: 'cta', label: 'Collegamento…' });
    busy.setAttribute('aria-busy', 'true');
    row.appendChild(busy);
    const disabled = uiButton(doc, { variant: 'primary', label: 'In attesa dei dati' });
    disabled.setAttribute('disabled', 'disabled');
    row.appendChild(disabled);
    row.appendChild(el(doc, 'span', 'ui-hint', 'Un primario disabilitato resta accanto al motivo che lo spiega.'));
    section.appendChild(row);
    box.appendChild(section);
  }

  function renderNavigation(box) {
    const section = heading(
      'Schede e segmenti',
      'Scheda sottolineata per le aree, controllo segmentato per I tuoi / Scopri.',
    );
    section.appendChild(uiTabs(doc, [
      { id: 'skill', label: 'Skill AI' },
      { id: 'connettori', label: 'Connettori', active: true },
      { id: 'pacchetti', label: 'Pacchetti' },
    ]));
    section.appendChild(uiSegmented(doc, [
      { id: 'mine', label: 'I tuoi' },
      { id: 'discover', label: 'Scopri', active: true },
    ]));
    box.appendChild(section);
  }

  function renderChips(box) {
    const section = heading('Chip dei canali', 'Una tinta per canale, sigla maiuscola come nel prototipo.');
    const row = el(doc, 'p', undefined);
    for (const channel of UI_CHANNELS) {
      row.appendChild(uiChannelChip(doc, channel));
      row.appendChild(el(doc, 'span', undefined, ' '));
    }
    section.appendChild(row);
    box.appendChild(section);
  }

  function renderCardTable(box) {
    const section = heading('Card e tabella', 'La scheda tiene un\u2019area, la tabella elenca righe con testate mono.');
    const card = uiCard(doc, { title: 'Riepilogo' });
    card.appendChild(uiTable(doc, {
      columns: ['Voce', 'Stato'],
      rows: [
        ['Follow-up a Paolo Esposito', 'da inviare'],
        ['Appuntamento con Giulia Romano', 'gioved\u00EC 15:00'],
      ],
    }));
    section.appendChild(card);
    box.appendChild(section);
  }

  function renderFields(box) {
    const section = heading(
      'Campi',
      'Ricerca con icona, menu a tendina con le opzioni dello schema, interruttore, segreto mai in chiaro.',
    );
    const searchRow = uiSearchField(doc, { placeholder: 'Cerca nome, email, azienda, telefono…', name: 'q' });
    section.appendChild(searchRow);
    const selectRow = uiSelect(doc, {
      name: 'stato',
      value: 'attivo',
      options: [
        { value: 'tutti', label: 'Tutti' },
        { value: 'attivo', label: 'Attivo' },
        { value: 'archiviato', label: 'Archiviato' },
      ],
    });
    section.appendChild(selectRow);
    section.appendChild(uiSwitch(doc, { name: 'sync', checked: true, label: 'Sincronizza il calendario' }));
    section.appendChild(uiSecretField(doc, { name: 'token', label: 'Token del connettore', hint: 'Viaggia come riferimento, mai in chiaro.' }));
    box.appendChild(section);
  }

  function renderBadges(box) {
    const section = heading(
      'Badge per autorit\u00E0',
      'Il colore nomina chi tiene il record: viola l\u2019agente, giallo la regola, corallo la persona, ciano l\u2019evidenza, verde l\u2019accordo. Rosso solo per i guasti.',
    );
    const row = el(doc, 'p', undefined);
    const samples = { agent: 'bozza AI', pending: 'in attesa', human: 'elena', evidence: 'traccia 42', accord: 'approvato', data: 'audit evt_1' };
    for (const authority of UI_AUTHORITIES) {
      row.appendChild(uiBadge(doc, { authority, text: samples[authority] ?? authority }));
      row.appendChild(el(doc, 'span', undefined, ' '));
    }
    const fault = uiBadge(doc, { authority: 'pending', text: 'failed' });
    fault.setAttribute('class', 'ui-badge ui-badge-fault');
    row.appendChild(fault);
    section.appendChild(row);
    box.appendChild(section);
  }

  function renderFeedback(box) {
    const section = heading('Toast e stato vuoto', 'Il toast conferma con la prova, il vuoto dichiara il fatto.');
    section.appendChild(uiToast(doc, { text: 'Preventivo versione 3 approvato. audit evt_01 registrato.' }));
    section.appendChild(uiToast(doc, { text: 'Lo storage ha rifiutato la scrittura. Nulla \u00E8 cambiato.', error: true }));
    section.appendChild(uiEmpty(doc, {
      title: 'Nessuna approvazione in attesa.',
      text: 'Il vuoto \u00E8 un fatto, dichiarato in chiaro. Niente illustrazioni.',
    }));
    box.appendChild(section);
  }

  function render() {
    clear();
    const page = el(doc, 'div', 'ui-catalog');
    page.appendChild(el(doc, 'p', 'kicker', 'Backoffice · sistema visivo'));
    page.appendChild(el(doc, 'h1', undefined, 'Catalogo dei componenti'));
    renderButtons(page);
    renderNavigation(page);
    renderChips(page);
    renderCardTable(page);
    renderFields(page);
    renderBadges(page);
    renderFeedback(page);
    mount.appendChild(page);
    return page;
  }

  return { render };
}
