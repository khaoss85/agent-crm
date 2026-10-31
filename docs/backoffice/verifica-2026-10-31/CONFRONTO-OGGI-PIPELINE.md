# Oggi e Pipeline /bo — confronto punto per punto col prototipo, 31/10/2026

Render: `npm run bo:shots -- --screen oggi` e `-- --screen pipeline` su
agent-crm main 376d6ed5, dati demo dello script (nomi, numeri e quantità
diversi dal prototipo, come il 29/10).
Riferimento: prototipo «Accordo Backoffice 2026-10-24» e
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` §Oggi (differenze piccole)
e §Pipeline (differenze piccole + un resto strutturale).
Entrambe le schermate girano sotto il mount /bo: sidebar con le voci
consegnate collegate, briciole «STUDIO AURORA / OGGI» e
«STUDIO AURORA / PIPELINE», nessun piè tecnico in inglese.

Esito: struttura e testi come il prototipo; i punti del 29/10 risultano
risolti, resta solo il noto dettaglio-pannello della Pipeline (follow-up).

## Oggi

1. Azione primaria col verbo del canale → RISOLTO: «Chiama» (TEL),
   «Invia follow-up» (email), «Apri scheda» (appuntamento); sotto ognuna la
   riga viola «✦ Ho preparato …: la vedi prima di …» (C del 29/10; test
   `advisor CTA speaks the channel verb, like the prototype`).
2. Sigla a sinistra → RISOLTO: sigla del canale (TEL, @, CAL), non più le
   iniziali del cliente.
3. Agenda → titoli in inchiostro scuro, nomi e orari come il prototipo;
   «Apri il calendario →» verde resta (test `agenda titles paint as dark ink,
   never green links`).
4. Struttura, saluto «Buongiorno, Elena», barra dell'advisor («0 di 3 fatte»),
   griglia Agenda / Prima della prossima call, banner connessioni
   «0 di 9 collegati»: come il prototipo e come il 29/10.
5. A 390 la schermata è a colonna unica, niente esce dallo schermo, niente
   scorrimento orizzontale; barra e card restano usabili.

## Pipeline

1. Importi, totali di colonna, previsione e riepilogo in italiano → come il
   prototipo: «✦ Previsione di ottobre» con mese, formula e rischio su due
   righe (una per valuta, mai sommate), totali «5 offerte · 2.099 € · 25 USD».
2. «Nuova offerta» verde in alto a destra sulla riga del titolo → come il
   prototipo.
3. Cinque colonne a 1440 (Richiesta info, Prova, Proposta, Pagato, Perso) con
   conteggio e totale; filtri a pillole «Referente Tutti», «Creata Sempre»,
   «Stati Tutti» → come il prototipo (#473, #492).
4. Card: sigla del referente, importo, «chiusura <data>», motivo di perdita,
   badge di tipo, «Apri» e «Sposta in» come alternativa accessibile al
   trascinamento → come il prototipo (#463, #488).
5. A 390 le colonne scorrono in orizzontale (Kanban), nessun testo tecnico,
   nessun piè di pagina: la vista resta usabile a colonna stretta.
6. RESTA (strutturale, follow-up già noto dal 29/10): il dettaglio offerta
   nel prototipo è un pannello laterale con schede Panoramica/Offerta/
   Attività; qui il bottone «Apri» espande il dettaglio dentro la card.
   La scheda Attività dipende dalla composizione locale
   (appointments/interactions), fuori da questa voce.

Date demo in forma ISO («chiusura 2026-11-15»): formato dei dati demo dello
script, non un formato prodotto; invariato dal 29/10, nessuna regressione.
