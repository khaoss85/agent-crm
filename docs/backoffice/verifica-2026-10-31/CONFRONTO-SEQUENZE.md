# Sequenze /bo — confronto punto per punto col prototipo, 31/10/2026

Render: `npm run bo:shots -- --screen sequenze` su agent-crm testa del branch
(dati demo dello script: nomi, numeri e quantità diversi dal prototipo, come il 29/10).
Riferimento: prototipo «Accordo Backoffice 2026-10-24» e
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` §Sequenze (4 punti),
più il vestito deciso dal supervisore (ANSWER 31/10 21:10).

Esito: struttura e testi come il prototipo; i 4 punti del 29/10 sono risolti.

1. Tre caselle «In corso / Risposte / Call fissate» senza card (regressione)
   → RISOLTO: card `metric` come Reporting (stessa classe, stesso padding,
   numero grande e riga sotto: «persone dentro adesso», «ferme alla prima
   risposta», «non lette in questa vista»). La regola CSS è condivisa con
   `.bo-rep`, così griglia e padding restano identici per costruzione
   (test `the dettaglio paints trigger pills, 3 KPI cards and the approval note`).
2. «Nuova sequenza» non a destra del titolo → RISOLTO: in alto a destra come
   CTA primaria verde; accanto «✦ Crea con l'AI» nei colori dell'assistente
   (vestito del supervisore 31/10: niente menu, due voci affiancate). La voce
   manuale nomina il passo dopo in italiano, quella AI mette il fuoco sulla
   barra AI; nessuna crea record finti (test `Nuova sequenza is the primary
   CTA with Crea con l'AI beside it`). Nel PNG 1440 si legge anche la frase
   della voce manuale: la sonda apre la voce, è uno stato vero, non testo fisso.
3. Card della lista senza descrizione del trigger → RISOLTO (fetta 1, #381):
   ogni riga dice «Quando …» dall'etichetta registrata e «Vedi i passi» apre
   il dettaglio; metriche contate dalle righe lette («2 persone · 50% risposte»).
4. Dettaglio con righe di testo invece delle pillole → RISOLTO: pillole
   «Parte quando: …» e «Si ferma quando: …» più «Attiva»/«Metti in pausa» con
   doppia domanda; sotto i passi per giorno e canale («Subito», «+2 giorni»,
   badge WA/@) e le persone con stato («In corso», «Completata»).

A 390 la schermata è a colonna unica, niente esce dallo schermo
(sonda `scrollWidth <= 390`); le due voci vanno a capo sotto il titolo.
Nessun controllo grezzo senza classe ui-* (test `the sequenze screen
renders no raw control`).
