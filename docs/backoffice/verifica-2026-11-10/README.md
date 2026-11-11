# Verifica a 390 px dal server, 10/11/2026

Prove a 390 px che la sessione Mac non poteva fare (la finestra non si
stringe, il /bo vieta l'iframe con `frame-ancestors 'none'`).

- agent-crm main `d238fd71e875c5d076f8b69fbb3cde868421378a` (#725)
- accordo-arvo-pilot main `983968d3684c4d14888e6147690454e05f1bd314` (#501) per backlog:aaafeded28af
- Chromium: headless shell 1248 del server (cache ms-playwright), sempre
  su 127.0.0.1 con i dati demo di `scripts/bo-shots.js`. Mai produzione,
  mai dati di Presti, mai il login di Dan.

## Come

1. `npm run bo:shots` dentro `scripts/ci-heavy.sh` (coda `ci`): 36 PNG,
   tutte le sonde passate. Qui ci sono quelli che servono, in `bo-shots/`
   (1440x1800 e 390x1600).
2. Misure e tocchi con il protocollo DevTools (`sonde/`): la stessa pagina
   di `bo:shots` (`harnessHtml`), con il telefono simulato a 390x844
   (mobile, tocco, `hover: none`, `pointer: coarse`). Due ritocchi rispetto
   a bo:shots, come fa l'app vera: la shell riceve `window` (per Esc e il
   focus); la scheda e il Calendario ricevono lo spazio attivo
   `spazio-demo` (la scheda come `spaceId`, il Calendario dallo storage
   della shell, come `app.js`). Risultati completi in `misure/*.json`.
   - La misura è legata alla larghezza chiesta: se `innerWidth` non è 390
     (o 1440) o se la pagina è più larga (`scrollWidth` > 390), la sonda
     segna `ok: false` ed esce con errore. Lo scorrimento laterale si conta
     contro 390, non contro `innerWidth`.
   - Le scritture vanno a uno stub che le registra. `POST
     /api/appointments/confirm` risponde «booked» solo se porta lo spazio
     atteso, `teamMemberId`, `serviceKey`, `startsAt`, `endsAt`,
     `sourceKey`, `subject.resource = contact` e `confirmed: true`;
     altrimenti 400. `POST /api/customer-hub/messages` risponde 400 se lo
     spazio non è quello atteso. Controllo al contrario: con uno spazio
     diverso la stessa Conferma riceve 400 e non compare «Prenotato».
   - **È una prova dell'interfaccia**: col dito a 390 parte la richiesta
     giusta, con i dati giusti, e la schermata mostra la risposta. **Non
     prova la prenotazione, il messaggio o l'offerta sul server.**
3. backlog:aaafeded28af: `node --test tests/browser/criteri-supervisore.browser.js`
   nel pilota, con il Chromium del server. L'esito scritto dalla prova è
   in `aaafeded28af/ESITO.md` (file della prova, non l'evidence del supervisore).

Nota sul server: `npm run bo:shots` qui salta in silenzio («no runnable
Chromium found») perché `chromiumRuns` in `scripts/bo-shots.js` prova il
binario senza `--no-sandbox` e su questo Ubuntu Chromium muore («No usable
sandbox»). Gli altri test `*-shots` riprovano con `--no-sandbox`. Per
questa prova ho usato un involucro (`sonde/chromium-nosandbox.sh`, prende
il binario da `CHROMIUM_REAL_BIN`, da `CHROMIUM_BIN` o da `chromium` nel
PATH); le sonde DevTools aggiungono `--no-sandbox` con `CHROMIUM_NO_SANDBOX=1`.

## backlog:d7c78e9cdf53 — telefono (390): messaggio, appuntamento, offerta

AC-1, tutto col tocco, senza hover (prova dell'interfaccia: parte la
richiesta giusta; il server non è provato):

| Passo | Misura |
|---|---|
| Scheda: «Scrivi» → composer | finestra 390x844 a tutto schermo (0,0), campi 16 px, scorrimento laterale 0 |
| Scheda: testo + «Invia su Email» | parte `POST /api/customer-hub/messages` con il testo scritto (`misure/interaction-measures.json`) |
| Scheda: «Nuova offerta» | finestra 390x844, campi 16 px, scorrimento laterale 0 |
| Offerta: Titolo, Valore, Referente + «Crea offerta» | parte `POST /api/opportunities` (valueCents 25000) |
| Calendario: tocco su «Conferma» della proposta | parte `POST /api/appointments/confirm` con `spaceId: spazio-demo` e il claim completo, lo stub risponde «booked», compare «Prenotato: marco · 22 ott 16:00.»; 0 elementi `draggable`, bottone 103x43. Controllo: con uno spazio diverso → 400, nessun «Prenotato» |
| Zoom | tutti i campi di Scheda, composer, offerta e Calendario a 16 px |
| Larghezza | Scheda, composer, offerta e Calendario: `innerWidth` 390, pagina 390 px |

Attenzione: la finestra dell'offerta scrive «Non viene inviata al cliente»
(`apps/admin/public/admin-offer-panel.js:443`). «Crea offerta» la registra,
ma dalla scheda non c'è un modo per mandarla al cliente. Se AC-1 con «si
manda» intende l'invio al cliente, manca la funzione: è una cosa del
prodotto, non del telefono.

AC-2: `bo-shots/cliente-390x1600.png`, `bo-shots/calendario-390x1600.png`,
`telefono/d7c78-scheda-390-offerta.png`: niente tagliato.

## backlog:34672b9f5a1f — Personalizzazione come il prototipo (AC-3)

PNG: `bo-shots/personalizzazione-1440x1800.png`,
`bo-shots/personalizzazione-390x1600.png`, pagina intera in
`telefono/personalizzazione-390-intera.png` e `-1440-intera.png`.

Il file del prototipo («Accordo Backoffice 2026-10-24.dc.html») non è sul
server. Il confronto usa la struttura che la sessione Mac ha letto dal file
(riga 06:56Z del 10/11). Tutti presenti a 390 e a 1440: schede Skill AI /
Connettori / Pacchetti (in quest'ordine), I tuoi / Scopri, Cerca, filtri,
ordina, «+ Aggiungi», carosello «Curato da Accordo · Kit social» con
IG/FB/TT/WA ed «Esplora», «Canali di conversazione» e «Agenda, lead e
pagamenti» con «Mostra tutto →». Le cose vecchie non ci sono più
(«Ordina: nome», «9 voci», «Collega i canali una volta sola…»). A 390:
scorrimento laterale 0, contenuto a 114 px, campi 16 px, frecce del
carosello insieme in basso a destra, puntini sotto.

## backlog:4419cc25e2df — barra del telefono entro 120 px (#720)

**Non passa su Clienti.** La barra è compatta su tutte e 4 le schermate, ma
a 390 Clienti non sta in 390 px: la pagina è larga 612 px e il telefono
la allarga (`innerWidth` 612). Causa: `apps/admin/public/styles.css:1292`,
vedi «Trovato in più». Oggi, Scheda e Calendario passano.

| Schermata (390x844) | Altezza barra | Inizio contenuto | Percorso visibile |
|---|---|---|---|
| Oggi | 110 px | 114 px | «Studio Aurora / Oggi», intero |
| Clienti | 110 px | 114 px | «Studio Aurora / Clienti», intero — **ma la pagina è larga 612 px, non 390 (`innerWidth` 612): sonda `ok: false`** |
| Scheda | 110 px | 114 px | «Studio Aurora / Clienti», intero |
| Calendario | 110 px | 114 px | «Studio Aurora / Calendario», intero |

Menu (☰ 44x44): tocco apre (cassetto 300 px, `role=dialog`, voce attiva
«Oggi» evidenziata, focus dentro), il ☰ resta sopra il cassetto e un
secondo tocco chiude; da tastiera Invio apre, Esc chiude e rimette il focus
sul ☰. PNG: `telefono/4419-oggi-390-menu-chiuso.png`,
`telefono/4419-oggi-390-menu-aperto.png`, più `bo-shots/{oggi,clienti,cliente,calendario}-390x1600.png`.

## backlog:aaafeded28af — criteri [supervisor] con Chromium sul server (AC-1)

Pilota `983968d`, spazio di prova `spazio-prova-bo`, sessione di prova
(mai il login di Dan): ogni criterio qui sotto apre la schermata, clicca,
controlla la richiesta e la risposta di rete e il testo atteso, e ha
scritto da solo la sua riga PASSA in `aaafeded28af/ESITO.md`.

- `oggi-da-rispondere`: 11 chiamate /bo/api
- `scheda-nota`: `POST /bo/api/customer-hub/notes` → 201
- `scheda-dettagli`: `PATCH /bo/api/contacts/<id>` → 200
- `pipeline-sposta-card`: `POST /bo/api/modules/opportunity/records/<id>/actions/move-stage` → 200

Schermate in `aaafeded28af/`. Nel log compare `ExecutorRefused
OPERATION_NOT_ALLOWED mark_customer_read` dello spazio di prova: non tocca
l'esito.

## Trovato in più: Clienti e Pipeline più larghi di 390 (tocca 4419cc25e2df su Clienti)

A 390 Clienti e Pipeline scorrono di lato: larghezza della pagina 612 px e
1073 px. Nella prima versione di questo README lo scorrimento risultava 0
perché la sonda lo contava contro `innerWidth`, che il telefono simulato
allarga a 612 e 1073: ora si conta contro 390 (`telefono/finding-*-scorrimento-laterale.png`). La causa sono le
etichette nascoste per i lettori di schermo, `position: absolute` senza un
contenitore posizionato dentro la tabella che scorre:

- `apps/admin/public/styles.css:1292` `.bo-clienti-label` (il contenitore
  `.bo-clienti-table` ha `overflow: auto` ma niente `position`)
- `apps/admin/public/styles.css:327` `.pipeline-column .stage-type` (si
  aggancia a `.pipeline-board-wrap`, fuori da `.pipeline-board` che scorre)

Basta `position: relative` su `.bo-clienti-table` e su `.pipeline-board`
(provato nel browser: 612 → 390 px e 1073 → 390 px).
