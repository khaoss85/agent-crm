# Backoffice Accordo — Roadmap a fasi

Voce `e2f1dfa0078b`. Solo documenti, nessun codice.

Fonte: prototipo ad alta fedeltà `Accordo Backoffice.dc.html` consegnato da Dan
(12 schermate, attributo `data-screen-label` da usare come reference) con il
brief `handoff/Prompt per lo sviluppo.md` nella stessa cartella di handoff.
Riferimento al comportamento reale nel file, non al riassunto.

Punto di partenza proposto nel brief, validato qui contro il codice su `main`
(commit `eb2e946`): **F0** sistema visivo, shell, permessi e policy;
**F1** canali + sync + Clienti + Scheda; **F2** Pipeline + catalogo +
preventivi + Stripe; **F3** Calendario + Sequenze + Oggi/Advisor;
**F4** Skill, Pacchetti, call intelligence, arricchimento, fonti;
**F5** moduli personalizzati come bundle + Reporting.

## Schermate del prototipo

| `data-screen-label` | Contenuto |
|---|---|
| 01 Login | accesso Google / link magico, racconto a 4 canali |
| 00 Oggi | saluto, Advisor AI, agenda, brief pre-call, invito canali |
| 02 Personalizzazione | schede Skill · Connettori · Pacchetti, viste I tuoi / Scopri |
| 03 Stato sync | stato generale, Da sistemare, tabella canali, feed |
| 04 Clienti | ricerca, viste, filtri, colonne, paginazione |
| 05 Scheda cliente | caso Giulia Romano, 3 colonne, timeline, risposta |
| 06 Pipeline | Kanban/Lista, card, stati, dettaglio offerta |
| 07 Calendario | settimana team, evento, Fissa con frase, link prenotazione |
| 10 Sequenze | elenco, dettaglio, passi, persone, pausa |
| 09 Reporting | bundle `reporting@1.2.0`, KPI, grafici, previsione, team |
| 11 Catalogo prodotti | tabella, Stripe, regole di prezzo, aggiunta prodotto |
| 08 Spazi e accessi | spazi, team, permessi AI |

Nota: il prop `startScreen` del prototipo elenca anche `account`, che non ha
alcun `data-screen-label` (vedi domanda Q-P1 in `OPEN-QUESTIONS.md`).

## Principi validi ovunque (dal brief, non negoziabili nelle storie)

- Sistema visivo dell'Admin: `apps/admin/public/styles.css` + `site/brand.json`
  (Bricolage Grotesque, Spline Sans Mono, fondo `#f7f3e9`; verificato su `main`).
- I colori indicano autorità, non gravità: viola = AI propone, giallo = regola
  ferma, corallo = persona decide, ciano = evidenza, verde = accordo, rosso
  solo guasti.
- L'AI propone, la persona approva: nessun messaggio al cliente senza ok, salvo
  permesso esplicito "Inviare risposte senza approvazione". Le policy
  deterministiche bloccano anche l'AI.
- Doppia opzione di creazione ovunque ("Crea con l'AI" / "Compila
  manualmente", con passaggio "Preferisco farlo con l'AI" nel manuale).
- Sync bidirezionale con evidenza: canale, direzione (← → ↔) e stato su ogni
  elemento.
- Moduli nativi nel kernel; moduli personalizzati come bundle separati,
  versionati, rimovibili senza toccare clienti, pipeline e calendario.
- Fonti cliccabili in ogni risposta AI. Italiano, testi brevi, fluido sotto i
  700px di contenuto.

## Riuso verificato su `main` (MEM_ACC_REUSE, niente doppioni)

Ogni storia riusa, non ricrea (dettagli e percorsi nei README citati):

- Record: `packages/modules/contact|company` (nessuna tabella clienti master).
- Identità canali, duplicati, import, profilo: `packages/customer-data`
  (`external-identity`, `duplicate-candidate`, `read-customer-profile`).
- Scheda in lettura: `packages/customer-hub` (proiezione, non possiede tabelle).
- Fondazione canali: `packages/channels` (`channel-connection`,
  `channel-inbox-event`, `channel-dead-letter`, contratto adapter, kit di test).
- Form sito: `packages/site-forms` (regola di risposta WhatsApp/email confermata).
- Conversazioni: `packages/interactions` (`interaction-log@1`).
- Appuntamenti: `packages/appointments` (`appointment-book@1`, anti-doppia
  prenotazione); sync Google: `packages/calendar-sync` (fake + stesso contratto
  per l'adapter vero).
- Listino e preventivi: `packages/commercial` (`product`, `price-book`,
  `offer`, `quote`).
- Pipeline: `packages/pipelines` (`accordo-sales`, opt-in per spazio) +
  `packages/modules/opportunity`; approvazioni: `packages/modules/approval`.
- Promemoria e task: `packages/work` (`follow-up@1`).
- Metriche ed export dichiarativi: `packages/analytics` (modello semantico,
  registro metriche, `compileReport`).
- Segnali e arricchimento: `packages/intelligence` (signals, enrichment).

Formato storia: **Ref** = schermata + elemento · **Accettazione** = criteri ·
**Dipendenze** = dal kernel · **Rischi** (API Meta/TikTok, consenso
registrazioni, GDPR arricchimento dove toccano).

## F0 — Sistema visivo, shell, permessi e policy

### BO-F0-01 Sistema visivo condiviso

- Ref: tutte le schermate (palette, font, colori di autorità).
- Accettazione: Admin e nuove viste usano gli stessi token di
  `apps/admin/public/styles.css` e `site/brand.json`; viola/giallo/corallo/
  ciano/verde/rosso con il significato del modello Accordo in ogni componente.
- Dipendenze: `site/brand.json`, stylesheet Admin (classe `pipeline-board`
  già presente).
- Rischi: nessuno.

### BO-F0-02 Shell e navigazione

- Ref: barra laterale di ogni schermata (selettore spazio ⌘1/2/3, Oggi, gruppi
  Moduli nativi / personalizzati, + Nuovo modulo, Impostazioni con badge,
  utente con logout) + barra superiore (percorso, barra AI ⌘K).
- Accettazione: navigazione in italiano; badge Impostazioni solo per cose da
  sistemare reali; scorciatoie ⌘1/2/3 cambiano spazio; fluido sotto i 700px.
- Dipendenze: record spazio esistenti (connessioni già space-scoped).
- Rischi: nessuno.

### BO-F0-03 Schede Impostazioni

- Ref: Impostazioni (Personalizzazione · Catalogo prodotti · Stato sync con
  badge · Spazi e accessi).
- Accettazione: le quattro schede aprono le schermate 02, 11, 03, 08; il badge
  sullo Stato sync riflette il contatore "Da sistemare" vero.
- Dipendenze: F1 (Stato sync), F2 (Catalogo).
- Rischi: nessuno.

### BO-F0-04 Barra AI e assistente laterale

- Ref: "Chiedi o fai qualcosa" + pannello (suggerimenti per schermata, risposte
  con fonti, azioni collegate, domande libere).
- Accettazione: suggerimenti diversi per schermata; ogni risposta cita fonti
  cliccabili (conversazioni, chiamate, documenti); azioni collegate eseguono
  davvero (filtra elenco, propone slot, scrive bozza); nessuna azione verso un
  cliente senza conferma.
- Dipendenze: `packages/intelligence`, `packages/interactions`, F1–F3.
- Rischi: quale LLM usare (Q-L1); costo e latenza delle domande libere.

### BO-F0-05 Login

- Ref: "01 Login" (Google / link magico, racconto a 4 canali, niente password).
- Accettazione: accesso con Google oppure link via email valido 10 minuti; a
  sinistra il racconto dei canali che convergono nella scheda di esempio.
- Dipendenze: meccanismo di auth dell'Admin esistente.
- Rischi: sensibile (login/sessioni: tetto 2 giri quando si implementa).

### BO-F0-06 Spazi, team e permessi AI

- Ref: "08 Spazi e accessi" (Apri / Nuovo spazio con doppia opzione, team con
  ruoli e canali di risposta, Invita persona con doppia opzione, 5 interruttori:
  unire duplicati, bozze, invio senza approvazione spento di default, fissare
  appuntamenti, spostare offerte).
- Accettazione: ogni spazio ha canali, clienti e team separati; l'invito assegna
  ruolo + canali; ciò che è spento diventa proposta da approvare.
- Dipendenze: modello permessi per spazio (Q-P2: confini kernel/blueprint).
- Rischi: nessuno sul modello; sensibile sui permessi in implementazione.

## F1 — Canali, sync, Clienti, Scheda cliente

### BO-F1-01 Adattatori dei 9 canali

- Ref: "02 Personalizzazione" (WhatsApp, Instagram, Facebook, TikTok solo in
  entrata, Email, Telefono/centralino, Form sito in entrata, Google Calendar,
  Stripe) + github.md (Connettori → `packages/channels/README.md`).
- Accettazione: ogni canale parla il contratto adapter di `packages/channels`
  (verifica firma, inbox con dedup, quarantena, kit di test); TikTok solo in
  entrata per contratto.
- Dipendenze: `packages/channels`, `packages/site-forms` per il Form sito.
- Rischi: API di Meta/TikTok (limiti, approvazioni app, Q-C1).

### BO-F1-02 Collegamento connettore in 3 passi

- Ref: "02 Personalizzazione" (autorizza → cosa sincronizzare → fatto; AI che
  unisce i duplicati; "cosa succede quando colleghi" se non collegato).
- Accettazione: procedura guidata in 3 passi; al termine i contatti duplicati
  diventano candidati in `duplicate-candidate`, mai uniti in silenzio.
- Dipendenze: `packages/customer-data`, OAuth reale (oggi simulato, vedi
  scarti in `COVERAGE.md`).
- Rischi: OAuth e permessi degli store/provider.

### BO-F1-03 Stato sync

- Ref: "03 Stato sync" (indicatore pulsante, "ultimo aggiornamento",
  "Sincronizza ora", tabella canali con direzione/ultimo/eventi/salute, feed
  tempo reale).
- Accettazione: contatori ed eventi letti dall'inbox reale; "Sincronizza ora"
  riesegue il pull; il feed mostra entra/esce con direzione ← → ↔.
- Dipendenze: `packages/channels`, `packages/calendar-sync`.
- Rischi: nessuno.

### BO-F1-04 Da sistemare: permessi e duplicati

- Ref: "03 Stato sync" (permesso in scadenza giallo; proposta AI viola sui due
  numeri di Paolo Esposito con "Sì, tienili entrambi" / "Decido io").
- Accettazione: permesso in scadenza = record vero con azione di rinnovo;
  proposta duplicati = `duplicate-candidate` con evidenza; la decisione umana
  è registrata con attore.
- Dipendenze: `packages/customer-data`, BO-F1-02.
- Rischi: GDPR sull'unione di identità (Q-G1).

### BO-F1-05 Elenco Clienti

- Ref: "04 Clienti" (ricerca in linguaggio naturale, 5 viste rapide, menu
  Filtri raggruppati + "Crea un filtro con l'AI", × sui filtri, ordinamento,
  colonne configurabili con "budget dichiarato estratto dall'AI",
  paginazione 10/25/50 con ellissi).
- Accettazione: viste = query salvate sui record contact/company; filtri per
  canale + stato; colonne attivabili inclusa la colonna AI con fonte;
  paginazione server-side.
- Dipendenze: `packages/modules/contact|company`, `packages/customer-data`.
- Rischi: nessuno.

### BO-F1-06 Scheda cliente (vista unica)

- Ref: "05 Scheda cliente" (caso Giulia Romano: DM Instagram → email con
  planimetria → telefonata → WhatsApp → prima call; sinistra: azioni rapide,
  identità collegate con motivazione, dettagli, "Arricchito dall'AI" con fonte;
  centro: cronologia per canale; destra: riepilogo AI, prossimi passi, offerta,
  prossimo appuntamento).
- Accettazione: ogni passaggio distinto per canale con direzione e stato sync;
  identità = `read-customer-profile` con motivazione; proiezione in sola
  lettura via `packages/customer-hub`.
- Dipendenze: `packages/customer-hub`, `packages/customer-data`,
  `packages/interactions`.
- Rischi: GDPR arricchimento (Q-G1).

### BO-F1-07 Risposta multicanale con approvazione

- Ref: "05 Scheda cliente" (campo risposta con canale preferito, "Scrivi con
  AI", invio "in consegna" → "consegnato").
- Accettazione: invio via outbox del canale con ricevuta; con permesso di
  invio spento ogni messaggio aspetta l'ok; audit con attore su ogni invio.
- Dipendenze: `packages/channels`, permessi BO-F0-06.
- Rischi: invii dal numero sbagliato (mittente sempre dallo spazio giusto).

### BO-F1-08 Chiamata: riepilogo, segnali, trascrizione

- Ref: "05 Scheda cliente" (riepilogo AI, segnali budget/tempi/interesse/dubbi,
  trascrizione apribile).
- Accettazione: trascrizione e segnali da `packages/intelligence`; consenso
  alla registrazione registrato prima di salvare audio/testo (Q-G2).
- Dipendenze: `packages/intelligence`.
- Rischi: consenso registrazioni, conservazione.

## F2 — Pipeline, catalogo, preventivi, Stripe

### BO-F2-01 Pipeline Kanban/Lista

- Ref: "06 Pipeline" (viste, ricerca, filtri referente/data/stato, "Azzera
  filtri", riepilogo numero+valore, previsione AI, card trascinabili).
- Accettazione: stadi da `packages/pipelines` (opt-in per spazio); drag & drop
  = `move-stage` con audit; previsione dichiarata come euristica.
- Dipendenze: `packages/pipelines`, `packages/modules/opportunity`.
- Rischi: nessuno. Conflitto stadi prototipo vs `accordo-sales` (Q-K1).

### BO-F2-02 Personalizza stati

- Ref: "06 Pipeline" (rinomina, riordina, colore, tipo Aperto/Vinto/Pagato/
  Perso/Rinnovo; elimina solo se vuoto; + Aggiungi stato; suggerimento AI
  Sopralluogo/Preventivo).
- Accettazione: tipi chiusi ai 5 del prototipo; eliminazione rifiutata se lo
  stato contiene offerte; suggerimento AI = proposta, mai applicato da solo.
- Dipendenze: `packages/pipelines` (definizione code-first, Q-K2: chi può
  ridefinire gli stadi).
- Rischi: nessuno.

### BO-F2-03 Costruttore del preventivo

- Ref: "06 Pipeline" scheda Offerta (voci dal catalogo con "S" se da Stripe,
  quantità −/+, rimozione, "Suggerisci voci dalle conversazioni" con motivo,
  sconto 0/5/10%, subtotale + IVA 22%, versioni, anteprima PDF).
- Accettazione: voci = record `offer` su `product`/`price-book` con snapshot
  immutabile del prezzo; suggerimenti AI con motivo citato; PDF generato dalla
  versione congelata.
- Dipendenze: `packages/commercial`.
- Rischi: nessuno.

### BO-F2-04 Regole di prezzo del catalogo

- Ref: "11 Catalogo prodotti" (sconti a quantità automatici, ok titolare sopra
  sconto massimo, IVA predefinita; "le regole bloccano anche l'AI").
- Accettazione: regole valutate dal pacchetto, non dall'interfaccia; un
  preventivo che viola una regola resta in bozza con motivo.
- Dipendenze: `packages/commercial` (oggi gli interruttori non applicano
  nulla: è lavoro vero, non riuso).
- Rischi: nessuno.

### BO-F2-05 Stripe: importazione e fonte prezzi

- Ref: "11 Catalogo prodotti" (import/sync prodotti, "Stripe come fonte dei
  prezzi" con prezzi non modificabili, invito se non collegato, tabella con
  fonte/attivo, filtri categoria, etichette sconto quantità).
- Accettazione: sync da Stripe in `product` con fonte marcata; con fonte
  prezzi attiva i campi prezzo sono read-only; gestione manuale senza Stripe.
- Dipendenze: `packages/commercial`, `packages/payments`.
- Rischi: credenziali Stripe (solo finte finché l'owner non le dà).

### BO-F2-06 Approvazione sopra 20.000 € e acconto Stripe

- Ref: "06 Pipeline" (sopra 20.000 € serve l'ok della titolare, poi invio sul
  canale preferito + link Stripe per l'acconto del 30%).
- Accettazione: soglia = regola deterministica; sblocco solo con approvazione
  registrata (`packages/modules/approval`); link d'acconto emesso dopo l'ok.
- Dipendenze: `packages/modules/approval`, `packages/payments`, BO-F1-07.
- Rischi: sensibile (pagamenti: tetto 2 giri in implementazione).

### BO-F2-07 Aggiunta prodotto con AI

- Ref: "11 Catalogo prodotti" ("Importa con l'AI" da PDF/Excel/foto, oppure
  manuale).
- Accettazione: import = bozza di record `product` da confermare riga per
  riga; mai scrittura diretta da documento non verificato.
- Dipendenze: `packages/commercial`.
- Rischi: prezzi letti male dall'AI (conferma umana obbligatoria).

## F3 — Calendario, Sequenze, Oggi/Advisor

### BO-F3-01 Calendario condiviso + sync Google

- Ref: "07 Calendario" (settimana team con colori, filtro persone, riga ora,
  dettaglio evento con origine e sync, link al cliente).
- Accettazione: eventi = `appointment-book@1`; sync bidirezionale via
  `packages/calendar-sync` (stesso contratto del fake per l'adapter vero).
- Dipendenze: `packages/appointments`, `packages/calendar-sync`.
- Rischi: quote e limiti delle API Google (Q-C1).

### BO-F3-02 Fissa con frase + prenotazione online

- Ref: "07 Calendario" (slot tratteggiati proposti, conferma crea evento +
  invito; link `accordo.dev/p/...`; "Nuovo appuntamento" con doppia opzione).
- Accettazione: slot = lettura reale delle disponibilità; creazione solo dopo
  conferma; prenotazione online scrive `appointment` con idempotenza per link.
- Dipendenze: BO-F3-01, permessi BO-F0-06 (fissare appuntamenti).
- Rischi: doppie prenotazioni da gara (test concorrente in implementazione).

### BO-F3-03 Sequenze

- Ref: "10 Sequenze" (elenco con stato e metriche; trigger/stop alla risposta;
  passi giorno+canale con personalizzazione AI; avviso permesso; persone con
  stati; pausa/riattivazione).
- Accettazione: stop automatico alla prima risposta registrata; senza permesso
  di invio ogni passo aspetta l'ok; metriche dai record reali.
- Dipendenze: `packages/work` (timer/promemoria), `packages/channels`,
  BO-F1-07. Motore nuovo: nessun pacchetto sequenze esiste (Q-K3).
- Rischi: invii indesiderati (fail-closed senza permesso).

### BO-F3-04 Oggi e Advisor AI

- Ref: "00 Oggi" (saluto con riepilogo in una frase; azioni con motivo,
  pulsante, "Domani", fatto/rimandato + "Annulla"; barra avanzamento; agenda;
  brief pre-call con fonti; invito canali mancanti).
- Accettazione: ogni azione Advisor cita il record che la motiva; fatto/
  rimandato reversibile; brief con fonti cliccabili.
- Dipendenze: `packages/work` (`follow-up@1`), BO-F3-01, BO-F1-01.
- Rischi: azioni su dati stantii (rilettura prima di eseguire).

## F4 — Skill, Pacchetti, intelligence

### BO-F4-01 Personalizzazione: Skill, Connettori, Pacchetti

- Ref: "02 Personalizzazione" (schede, I tuoi/Scopri, ricerca/filtri/
  ordinamento, "Aggiungi" con doppia opzione, banner carosello, card con
  "Prova" e +/✓, tabella stati, stato vuoto Pacchetti, "Sviluppa per Accordo").
- Accettazione: "Prova" = dimostrazione su caso reale senza scrivere nulla;
  attivazione = composizione registrata per spazio.
- Dipendenze: composizione dei moduli esistenti del framework.
- Rischi: nessuno.

### BO-F4-02 Formato reale delle skill

- Ref: "02 Personalizzazione" dettaglio skill (ciclo in 6 passi, regole
  attivabili, esempio con traccia, "Nel tuo progetto Accordo", connettori
  usati; ⚠ sintassi pseudo-codice).
- Accettazione: definizione allineata al vero formato del kernel
  (package nativo + capability dichiarata, non pseudo-codice); prompt copiabile
  per l'agente di coding che genera bundle separati.
- Dipendenze: `docs/PACKAGE_AUTHORING.md`, formato moduli.
- Rischi: nessuno. Domanda Q-K4 (formato canonico da decidere).

### BO-F4-03 Call intelligence ed enrichment

- Ref: "05 Scheda cliente" (segnali, trascrizione, "Arricchito dall'AI" con
  fonte per dato).
- Accettazione: segnali e trascrizione da `packages/intelligence`; ogni dato
  arricchito cita la fonte; nessun salvataggio senza consenso (Q-G1/Q-G2).
- Dipendenze: `packages/intelligence`, BO-F1-08.
- Rischi: GDPR, conservazione trascrizioni.

### BO-F4-04 Fonti nelle risposte AI

- Ref: assistente (risposte con fonti) + scheda skill (esempio con traccia).
- Accettazione: ogni citazione apre il record di origine; traccia di
  esecuzione conservata e ispezionabile.
- Dipendenze: `packages/intelligence`, audit del core.
- Rischi: nessuno.

## F5 — Moduli personalizzati e Reporting

### BO-F5-01 Bundle separati e "Nuovo modulo"

- Ref: "09 Reporting" (bundle separato dal kernel, generato dall'agente di
  coding) + "+ Nuovo modulo" con doppia opzione + card "Sviluppa per Accordo".
- Accettazione: bundle versionato, rimovibile senza toccare clienti/pipeline/
  calendario; "Crea con l'AI" genera davvero un bundle installabile (oggi
  simulato).
- Dipendenze: formato moduli/bundle (Q-K4).
- Rischi: codice generato nel processo condiviso (resta fuori: bundle
  separati, mai codice cliente nel processo condiviso).

### BO-F5-02 Reporting

- Ref: "09 Reporting" (filtri periodo/persona con ricalcolo; 5 indicatori;
  4 grafici + previsione verso obiettivo; tabella Team e vendite; "Cosa noto"
  con ridistribuzione lead; struttura bundle + prompt; export CSV).
- Accettazione: metriche dal registro dichiarato di `packages/analytics`
  (niente query ad hoc); previsione marcata come euristica; "Cosa noto" =
  proposta, mai riassegnazione automatica.
- Dipendenze: `packages/analytics`, BO-F5-01.
- Rischi: numeri letti come promesse (etichettare le euristiche).

### BO-F5-03 Dettaglio connettore

- Ref: "02 Personalizzazione" (cosa entra, anteprima in scheda, impostazioni
  account/interruttori/chi risponde, dettagli tecnici, skill che lo usano).
- Accettazione: ogni voce del dettaglio legge lo stesso record di
  `channel-connection`; "skill che lo usano" = dipendenze dichiarate.
- Dipendenze: `packages/channels`, BO-F1-01.
- Rischi: nessuno.

## Dipendenze tra fasi

F0 prima di tutto (shell, policy, permessi). F1 prima di F2–F4 (identità,
canali e sync sono il fondamento). F2 prima di F3-04 (l'Advisor propone
follow-up su offerte). F4-02 (formato skill) prima di F5-01 (bundle generati).
F5 per ultimo: ospita Reporting sopra metriche dichiarate.

