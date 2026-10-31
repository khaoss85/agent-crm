# Confronto con il prototipo, 29/10/2026 (supervisore)

Render: `node scripts/bo-shots.js` su agent-crm main 5843cf9, dati demo dello script (diversi da quelli del prototipo: nomi, numeri e quantità non contano). Riferimento: le schermate del prototipo «Accordo Backoffice 2026-10-24» a 1440 e le checklist `specs/<schermata>.md`. Foto 1440 e 390 di ogni schermata in questa cartella. Il confronto qui sotto è fatto a 1440; a 390 controllato solo che nulla esca dallo schermo.

Esito per schermata: **UGUALE** = struttura e testi come il prototipo, differenze solo nei dati; **DIFFERENZE** = elenco dei punti da sistemare.

## Login — backlog:27a0b924a3a6 — UGUALE (pagina del framework)
- Colonna scura con marchio, titolo, sottotitolo; a destra ACCEDI, «Bentornata», «Continua con Google», «oppure», email, «Ricevi il link di accesso», nota, «Crea uno spazio gratuito»: tutto come il prototipo. Manca solo il filo di messaggi in basso a sinistra (a 1800 di altezza resta sotto la piega nel prototipo, qui non compare): da controllare.
- In produzione però chi apre /w/<spazio>/ vede la pagina del pilota (src/shared/login.js), non questa: voci f9680c478410 e 3583bb92ef69.

## Oggi — backlog:9c7d1477a8d4 — DIFFERENZE (piccole)
- Card attività: manca la terza riga viola «✦ …» (nota dell'AI) quando il dato c'è; l'azione primaria è «Completa»/«Apri scheda» invece del verbo del canale («Invia follow-up», «Rispondi», «Chiama», «Riscrivi», «Invia promemoria»).
- Sigla a sinistra: iniziali del cliente («GR») dove il prototipo mostra il canale (@, TT, TEL, IG, S).
- Agenda: riga secondaria in grigio senza link sottolineato verde; separatore fra gli appuntamenti.
- Struttura, titolo, advisor con barra, griglia Agenda / Prima della prossima call, banner connessioni: come il prototipo.

## Clienti — backlog:22d4dd0f0fbb — DIFFERENZE
- «Aggiungi cliente» è testo semplice: nel prototipo è il bottone verde pieno con freccia del menu.
- Le schede filtro non hanno i conteggi (Tutti 48, Da ricontattare oggi 3…).
- A destra della barra filtri il prototipo ha tre icone (filtri, ordina, colonne 5/10); qui ci sono quattro parole («Filtri», «✦ Crea un filtro con l'AI», «Ordina», «Colonne 4/8»).
- Colonna ULTIMO CONTATTO: nel prototipo sigla canale + anteprima del messaggio + riga mono «WhatsApp · oggi 10:20»; qui solo «WhatsApp · 20 ott».
- Sotto il nome: il prototipo mostra «città · referente», qui l'azienda.

## Scheda cliente — backlog:59def6cb805d — DIFFERENZE (grandi)
- Manca il pannello viola in alto «✦ Recap per …» con «Vista per» (schede per tipo di attività), le quattro caselle (Progetto, Budget, Inizio lavori, Stile) e «PROSSIME AZIONI» con i bottoni. Se il riepilogo non c'è, il pannello non compare: resta da decidere lo stato vuoto.
- Azioni rapide: 2 (Chiama, Email) contro 6 con icona (Chiama, WhatsApp, Email, Appuntamento, Offerta, Chiedi all'AI).
- Identità collegate: il prototipo elenca ogni identità con sigla del canale e «↔ sincronizzato», più il riquadro viola «✦ 4 identità unite automaticamente…»; qui testo semplice.
- «✦ ✦ Riepilogo AI»: la stella è doppia (difetto).
- Card «Chiamate» non esiste nel prototipo.
- Offerta: il prototipo ha l'occhiello OFFERTA, il nome, l'importo grande e la pillola «In attesa»; qui una riga «Preventivo … · inviata».
- Prossimo appuntamento: occhiello mono e riga «↔ Google Calendar · Marco» mancanti.
- Cronologia: buona; mancano ora a destra, «Segnali» e i chip viola dell'AI quando ci sono.

## Pipeline — backlog:61800913 (aggiornato 31/10/2026 su main 74097955, proof in tests/fixtures/bo-shots-proof/pipeline-*.png) — DIFFERENZE (piccole, una strutturale)
- Importi: «1.200 €», totali di colonna, previsione e riepilogo in italiano — come il prototipo (design pass 4, #433).
- «Nuova offerta» verde in alto a destra sulla riga del titolo, con le due voci del prototipo — come il prototipo (#468, #492 backlog:339ca222).
- Previsione «✦ Previsione di ottobre» con mese, formula e rischio («Vinte e pagate, più il 60% di quelle in attesa — stima, non un impegno»): due righe per valuta perché le valute non si sommano mai (scelta di progetto, #467). Frase e mese come il prototipo.
- Filtri a pillole «Referente Tutti», «Creata Sempre», «Stati Tutti» — come il prototipo (#473). «Personalizza stati» resta della storia F2-02 (rinomina/riordina/stati, backlog:7332a341): non di questa voce.
- Card: sigla del referente (MF/SC, titolo accessibile col nome intero), importo, «chiusura <data>», motivo di perdita, badge di tipo «Aperta/Vinta ✓/Persa ✕» e dot di stato — come il prototipo (#463, #411, #488 backlog:96e7b579). Il controllo «Sposta in» resta dentro la card come alternativa accessibile al trascinamento (scelta di progetto). Probabilità di stato solo nella vista Lista, non sulla card.
- RESTA (strutturale, follow-up): il dettaglio offerta nel prototipo è un pannello laterale con schede Panoramica/Offerta/Attività; qui il bottone «Apri» espande il dettaglio dentro la card (importo, chiusura, referente modificabili, #488). La scheda Attività dipende dalla composizione locale (appointments/interactions), esclusa da questa voce.

## Calendario — backlog:5fbebe8559e9 — DIFFERENZE (grandi)
- In alto nella colonna sinistra manca la card dell'appuntamento scelto (titolo, data, persona, «Prenotato da … su WhatsApp», «↔ Google Calendar · invito al cliente inviato», «Apri scheda cliente»).
- Team: il prototipo ha l'elenco con casella colorata, sigla, nome e ruolo; qui un campo di testo «marco, sara» con «Mostra settimana».
- Il modulo «Nuovo appuntamento» è aperto e lungo nella colonna; nel prototipo non c'è (si apre dal bottone).
- Manca la card «Prenotazione online» con link e «Copia».
- Intestazione dei giorni: il prototipo «Lun 19» con il numero di oggi nel cerchio; qui «lun 19».

## Sequenze — backlog:c0b0b3420aff — DIFFERENZE (grandi)
- Le tre caselle «In corso / Risposte / Call fissate» sono diventate testo in colonna senza card (regressione).
- «Nuova sequenza» è sotto il sottotitolo con un anello di fuoco; nel prototipo è a destra del titolo. La frase aggiunta «Descrivi la sequenza nella barra AI…» non è nel prototipo.
- Card della lista: il prototipo mostra la descrizione del trigger («Quando un nuovo contatto scrive…»); qui «Quando parte» e un bottone «Vedi i passi».
- Dettaglio: il prototipo ha le pillole «Parte quando: …» (azzurra) e «Si ferma quando: …» (verde) e «Metti in pausa»; qui righe di testo e bottone «Attiva».

## Reporting — backlog:d34b1d2d75de — DIFFERENZE
- Etichette sotto il titolo: il prototipo ha la pillola scura «reporting@1.2.0», la pillola viola «Bundle separato dal kernel» e il testo grigio; qui tre testi mono uguali.
- Filtri: il prototipo ha il segmento «Settimana / Mese / Trimestre» e le sigle delle persone in cerchio; qui i mesi e i nomi in pillole.
- Previsione: il prototipo ha la barra a tre segmenti con legenda «Chiuse / Probabili / Se chiudi tutto» e «✦ Sei in linea con l'obiettivo»; qui una riga mono in grassetto.
- Importi «26.000,00 EUR»: nel prototipo «21.400 €».
- Griglia e pannelli: come il prototipo.

## Personalizzazione (Connettori) — backlog:34672b9f5a1f — UGUALE
- Schede, ricerca, Aggiungi, banner «Kit social» con frecce, due gruppi di card con sigla, descrizione, provenienza e stato: come il prototipo. Ricerca: il prototipo ha icone filtro/ordina dove qui ci sono due select (piccola differenza).

## Catalogo prodotti — backlog:c7deb9c21f3b — DIFFERENZE
- Manca il bottone verde «Aggiungi prodotto».
- Card Stripe: manca «Stripe come fonte dei prezzi» con l'interruttore.
- Filtri: il prototipo ha le categorie con conteggio e la ricerca «Cerca prodotto o codice»; qui i campi «Categoria / Tutti / Fonte / Filtra».
- Tabella: mancano SCONTO MAX e QUANTITÀ con i passi −/+; il prezzo è «Prezzo del pacchetto: EUR 99.00» + «Modifica prezzi» invece del campo prezzo con €.
- Regole di prezzo: il prototipo ha una riga per regola con interruttore; qui una frase.

## Stato sync — backlog:3a3e6eaff1c5 — UGUALE (piccole differenze)
- Bottoni «Collega»: nel prototipo pieni scuri, qui chiari con bordo.
- «1 di 9 collegati» va a destra nell'intestazione della card, non su una riga sotto.
- Colonna «agg. …» (ultimo aggiornamento) mancante nella tabella canali.

## Spazi e accessi — backlog:6b44b0e9fcdf — DIFFERENZE (piccole)
- Card spazio: mancano la riga sotto il nome (attività · città) e la riga «6 canali · 4 persone · 214 clienti»; sugli altri spazi manca «Apri».
- Team: il prototipo mostra email sotto il nome, colonna «↔ Google Calendar» e le sigle dei canali della persona; titolo «Team di <spazio>».
