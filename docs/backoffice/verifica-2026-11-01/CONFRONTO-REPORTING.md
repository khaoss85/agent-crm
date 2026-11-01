# Reporting /bo — confronto punto per punto col prototipo, 01/11/2026

Render: `CHROMIUM_BIN=chromium-server node scripts/bo-shots.js -- --screen reporting`
su agent-crm main `c1ecd28a` (dati demo dello script: nomi alice/bob, mesi
set–nov 2026, importi diversi dal prototipo, come il 29/10). Sonda di pittura
passata su entrambi i render (spazio «Studio Aurora», pill «Reporting»).
Riferimento: prototipo «Accordo Backoffice 2026-10-24» e
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` §Reporting (4 punti).

Esito: struttura e testi come il prototipo; i punti 1 e 3 del 29/10 sono
risolti, i punti 2 e 4 restano differenze piccole di formato dei dati demo.
Le fette di sola composizione locale (appuntamenti, follow-up, call) restano
fuori da questa voce, come da mappa.

1. Etichette sotto il titolo → RISOLTO: pillola scura «Clienti, preventivi e
   vendite», pillola viola «Si toglie senza rompere niente», testo grigio
   «Fatto dal tuo agente di coding» (design pass 5, #436).
2. Filtri periodo e persona → mesi «set 2026 / ott 2026 / nov 2026» più
   «Tutti»; persone a sigle («A», «B») con il nome intero in title,
   aria-label e data-owner, e il valore pieno mandato al dashboard
   (#510, test `same-sigla accessible name`). Differenza piccola restante:
   il prototipo aveva il segmento «Settimana / Mese / Trimestre» e le sigle
   in cerchio; qui pillole rettangolari. P3 noto: due sigle uguali restano
   visivamente identiche (distinzione via title/aria-label).
3. Indicatori → 5 card (Valore pipeline aperto, Preventivi aperti, Vinte in
   ottobre 2026, Tasso di chiusura, In chiusura in ottobre 2026), ognuna
   con la riga di dettaglio: come il prototipo.
4. Barre impilate «Nuovi clienti per canale» → barre per settimana con
   legenda Instagram/WhatsApp: come il prototipo.
5. Percorso preventivi «Preventivi dall'invio al pagamento»
   (Qualifica/Trattativa/Vinte) più «Valore per fase», «Chiusure attese per
   mese», «Vendite per persona»: come il prototipo.
6. Previsione verso l'obiettivo → RISOLTO: barra con legenda «Chiuse /
   Probabili / Se chiudi tutto», riga «Chiuse … · probabili … · se chiudi
   tutto …», «Ti mancano … per l'obiettivo», «Obiettivo 20.000,00 €» in
   euro (#515), nota «Stima: … non è una promessa». Il punto del 29/10
   (riga mono in grassetto) non c'è più.
7. Tabella «Team e vendite» → colonne Persona/Preventivi/Valore aperto/
   Vinte/Tasso: come il prototipo.
8. «Cosa noto» → nota («alice tiene molto aperto … propone di spostare i
   lead senza data a bob») con bottone «Proponi ridistribuzione dei lead»:
   come il prototipo.
9. Formato importi («26.000,00 EUR», «140,00 €») contro «21.400 €» del
   prototipo: formato dei dati demo dello script, invariato dal 29/10;
   l'obiettivo è in euro dal #515. Nessuna regressione.
10. A 390 la pagina è a colonna unica, card impilate, filtri a capo; la
    tabella del team scorre dentro il proprio contenitore (`.table-wrap`),
    la pagina non scorre in orizzontale. Nessun controllo grezzo senza
    classe `ui-*` (test `every control carries a ui-* system class`).
