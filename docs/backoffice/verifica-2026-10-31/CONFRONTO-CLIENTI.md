# Clienti /bo — confronto punto per punto col prototipo, 31/10/2026

Render: `npm run bo:shots -- --screen clienti` su agent-crm main e9b9bf16,
dati demo dello script (nomi, numeri e quantità diversi dal prototipo, come il 29/10).
Riferimento: prototipo «Accordo Backoffice 2026-10-24» e
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` §Clienti (5 punti).

Esito: struttura e testi come il prototipo; restano due differenze note e motivate.

1. «Aggiungi cliente» è testo semplice → RISOLTO: bottone verde pieno con freccia
   del menu (C6; `Aggiungi cliente opens a menu with the two prototype entries`).
2. Schede filtro senza conteggi → RISOLTO: pill con conteggi dal server
   (Tutti 3, Da ricontattare oggi 1, Nuovi lead 1, Clienti attivi 1). «Rinnovi entro
   30 giorni» resta senza numero per scelta: il server non lo nomina e la vista
   resta onesta invece di inventarlo (C10; test `view pills show server counts…`).
3. Quattro parole invece delle tre icone → RISOLTO: a destra della barra filtri ci
   sono le tre icone (filtri, ordina, colonne 4/8) come il prototipo (C11).
4. Colonna ULTIMO CONTATTO senza anteprima → RISOLTO: sigla canale + anteprima
   del messaggio + riga «canale · quando» («WhatsApp · 20 ott»; «oggi HH:MM» per
   i contatti di oggi a Roma). La demo mostra l'estratto su Marco Rossi; Anna
   Bianchi resta «mai» e le chiamate non inventano mai un estratto (C16; test
   `Ultimo contatto paints the mark, the excerpt and «canale · quando»`).
5. Sotto il nome «città · referente» → NON APPLICABILE: il contratto lista non
   espone città né referente e la vista non inventa dati (motivato in #465, C16).

A 390 la schermata è a colonna unica, niente esce dallo schermo; il menu resta
usabile (C24–C28, vestito del supervisore). Stili e shell intoccati (styles.css,
admin-shell.js: regola dell'owner). Nessun controllo grezzo senza classe ui-*
(test `the clienti screen renders no raw control`).
