# Sequenze (/bo) — voci funzionali e test che le provano

Schermata «10 Sequenze» del prototipo: elenco con stato e metriche,
dettaglio con passi giorno+canale, persone con stati, pausa/riattivazione.
Riferimenti: `docs/backoffice/ROADMAP.md` (BO-F3-03, BO-F6-12),
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` (sezione Sequenze).

Vincoli del supervisore (ANSWER 28/10): il vestito visivo (CSS in
`apps/admin/public/styles.css`, spaziature, larghezze, scala dei titoli,
colori, card, shell) lo fa il supervisore. Qui solo parti funzionali,
markup minimo, testi italiani esatti del prototipo. Niente `styles.css`
né `admin-shell.js` toccati da queste voci.

## Mappa voce → test

| # | Voce funzionale | Stato | Test che la prova |
|---|---|---|---|
| 1 | Menu «Nuova sequenza» (CTA verde unico) con «Crea con l'AI» / «Compila manualmente», si chiude con Escape e click fuori | Fatta (#421, #427, questa PR) | `tests/admin-sequenze.test.js`: «Nuova sequenza opens a two-entry menu and Escape closes it», «the opening click does not close…», «Escape at document level…», «the menu keeps keyboard focus…» |
| 2 | La scelta «Crea con l'AI» sposta il fuoco sulla barra AI vera (il suo placeholder di schermata dice già cosa scrivere); senza barra il menu si chiude e basta, senza frasi inventate | Fatta (questa PR; prima c'era la frase «Descrivi la sequenza nella barra AI…», tolta perché non è nel prototipo) | `tests/admin-sequenze.test.js`: «the AI entry focuses the shell AI bar…», «without the shell bar the AI entry just closes the menu» |
| 3 | La scelta «Compila manualmente» dice onestamente il passo dopo (la sequenza si crea dallo spazio e compare qui) | Fatta (#421) | `tests/admin-sequenze.test.js`: «picking the manual entry closes the menu…» |
| 4 | KPI «In corso» e «Risposte» contate dalle righe lette; «Call fissate» resta «—» onesto (la vista non legge gli appuntamenti) | Fatta (#421) | `tests/admin-sequenze.test.js`: «the dettaglio paints trigger pills, 3 KPI cards…» |
| 5 | Etichette giorno «Subito», «+1 giorno», «+N giorni»; senza offset «Giorno da decidere», mai vuoto | Fatta (#421) | `tests/admin-sequenze.test.js`: day-label (sequenceDayLabel) |
| 6 | Elenco: riga per sequenza con stato («Bozza/Attiva/In pausa»), riga «Quando …» dal trigger (onesto «Quando parte» se l'operatore non l'ha nominato), statistiche persone/risposte o frasi oneste («in pausa», «Nessuna persona dentro…») | Fatta (#421; dati demo con trigger in questa PR) | `tests/admin-sequenze.test.js`: buildSequenzeElenco; `scripts/bo-shots.js` probe `sequenze` (2 righe, nomi, dettaglio, 2 passi) |
| 7 | Dettaglio: pillole «Parte quando: …» e «Si ferma quando: …» (lo stop cade sull'invariante del pacchetto: prima risposta registrata) | Fatta (#421) | `tests/admin-sequenze.test.js`: «the dettaglio paints trigger pills…» |
| 8 | «Attiva» / «Riattiva» / «Metti in pausa» con doppia domanda in italiano; dopo la pausa «Riattiva» e pillola «In pausa»; errore di concorrenza onesto con ricarica | Fatta (#421) | `tests/admin-sequenze.test.js`: «pausing an active sequence offers Riattiva…» |
| 9 | Passi in linea del tempo: giorno, sigla canale, «Canale · titolo», nomi modello tra virgolette, variabili in italiano («✦ Personalizzato con il nome»); passi illeggibili detti mancanti, non zero | Fatta (#421) | `tests/admin-sequenze.test.js`: buildSequenzaDettaglio |
| 10 | Persone con sigla, «Passo n di m» / «In attesa» / «Uscita», prossima scadenza a Roma o «Prossimo invio da decidere», pillole «In corso/Da approvare/Programmata/Completata» | Fatta (#421) | `tests/admin-sequenze.test.js`: personStatusLabel, personStepLabel |
| 11 | Stati vuoti e letture fallite in italiano, mai codici («follow-up · task-1», NOT_FOUND, undefined); stati ignoti detti tali | Fatta (#421) | `tests/admin-sequenze.test.js`: «empty screens stay simple…», «a refused write says the state moved…» |
| 12 | Niente controlli grezzi: ogni bottone/campo visibile usa una classe `ui-*` | Fatta (#421) | `tests/admin-sequenze.test.js`: «the sequenze screen renders no raw control» (header, menu aperto, dettaglio) |
| 13 | Dati demo dello spazio di prova con trigger e stop, così gli shot mostrano «Quando un nuovo contatto scrive…» invece dei ripieghi | Fatta (questa PR) | `scripts/bo-shots.js` `DEMO_SEQUENCES`; probe `sequenze` in `tests/bo-shots.test.js` |

## Resta al supervisore (vestito, non in questa PR)

- Posizione di «Nuova sequenza» (prototipo: a destra del titolo) e card KPI / righe: solo CSS.
- PNG 1440/390 con `bo:shots` e confronto punto per punto col prototipo.
- Persone «in tabella»: il markup a righe c'è, la forma tabellare è CSS.

## Decisioni (da confermare)

- DECISION (to be confirmed): la scelta AI mette il fuoco sulla barra AI invece di una frase di aiuto, perché la barra è l'ingresso reale e la frase non è nel prototipo. La scelta manuale tiene la sua frase onesta perché dal /bo non esiste ancora una creazione manuale.
- DECISION (to be confirmed): «Call fissate» resta «—» finché la vista non legge davvero gli appuntamenti; inventare un numero sarebbe peggio.
