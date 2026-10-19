# Backoffice Accordo — Matrice di copertura

Voce `e2f1dfa0078b`. Ogni voce dell'inventario del brief
(`handoff/Prompt per lo sviluppo.md`, sezione "Inventario funzionale") compare
in almeno una storia di `ROADMAP.md`. Gli scarti espliciti stanno in fondo,
con motivo.

Legenda storie: F0 fondazione · F1 canali/sync/clienti · F2 pipeline/catalogo ·
F3 calendario/sequenze/oggi · F4 skill/intelligence · F5 bundle/reporting.

## Shell e navigazione

| Voce dell'inventario | Storia |
|---|---|
| selettore spazio, ⌘1/2/3 | BO-F0-02 |
| Oggi | BO-F0-02, BO-F3-04 |
| gruppo Moduli nativi | BO-F0-02 |
| gruppo Moduli personalizzati + Nuovo modulo doppia opzione | BO-F0-02, BO-F5-01 |
| Impostazioni + badge | BO-F0-02, BO-F0-03 |
| utente con logout | BO-F0-02 |
| schede Impostazioni (4) | BO-F0-03 |
| barra superiore percorso + barra AI ⌘K | BO-F0-02, BO-F0-04 |
| assistente: suggerimenti per schermata | BO-F0-04 |
| assistente: risposte con fonti | BO-F0-04, BO-F4-04 |
| assistente: azioni collegate | BO-F0-04 |
| assistente: domande libere con LLM | BO-F0-04 (Q-L1) |

## 01 Login

| Voce dell'inventario | Storia |
|---|---|
| Google oppure link magico, senza password | BO-F0-05 |
| racconto visivo 4 canali → scheda Giulia | BO-F0-05 |

## 00 Oggi

| Voce dell'inventario | Storia |
|---|---|
| saluto + riepilogo in una frase | BO-F3-04 |
| Advisor: azioni con motivo, pulsante, Domani, fatto/rimandato + Annulla | BO-F3-04 |
| barra di avanzamento | BO-F3-04 |
| agenda di oggi | BO-F3-04 |
| brief pre-call con fonti | BO-F3-04 |
| invito a completare i canali | BO-F3-04 |

## Personalizzazione

| Voce dell'inventario | Storia |
|---|---|
| schede Skill · Connettori · Pacchetti; viste I tuoi / Scopri | BO-F4-01 |
| ricerca, filtri, ordinamento, Aggiungi doppia opzione | BO-F4-01 |
| banner carosello; card con Prova e +/✓ | BO-F4-01 |
| tabella I tuoi (Riconnetti/✓/Collega, interruttori skill) | BO-F4-01 |
| stato vuoto Pacchetti; card Sviluppa per Accordo | BO-F4-01 |
| collegamento in 3 passi; AI unisce duplicati | BO-F1-02 |
| dettaglio connettore (entra, anteprima, impostazioni, cosa-succede, tecnici, skill) | BO-F5-03 |
| dettaglio skill (ciclo 6 passi, regole, esempio con traccia, definizione codice, connettori) | BO-F4-02 |
| sintassi pseudo-codice da allineare | BO-F4-02 (Q-K4) |
| 9 canali | BO-F1-01 |

## 03 Stato sync

| Voce dell'inventario | Storia |
|---|---|
| indicatore pulsante, ultimo aggiornamento, Sincronizza ora | BO-F1-03 |
| permesso in scadenza (giallo) | BO-F1-04 |
| proposta AI duplicati viola con decisione | BO-F1-04 |
| tabella canali + feed tempo reale | BO-F1-03 |

## 04 Clienti

| Voce dell'inventario | Storia |
|---|---|
| ricerca in linguaggio naturale; 5 viste rapide | BO-F1-05 |
| menu Filtri raggruppati + filtro con AI; × sui filtri | BO-F1-05 |
| ordinamento (ultimo contatto, nome, valore, stato) | BO-F1-05 |
| colonne configurabili incl. budget AI | BO-F1-05 |
| paginazione con ellissi, 10/25/50 | BO-F1-05 |

## 05 Scheda cliente

| Voce dell'inventario | Storia |
|---|---|
| caso Giulia (IG → email → telefono → WhatsApp → call) | BO-F1-06 |
| azioni rapide incl. Offerta doppia opzione | BO-F1-06 |
| identità collegate con motivazione | BO-F1-06 |
| dettagli; Arricchito dall'AI con fonte | BO-F1-06, BO-F4-03 |
| cronologia filtrabile per canale | BO-F1-06 |
| chiamata: riepilogo AI, segnali, trascrizione | BO-F1-08, BO-F4-03 |
| risposta: canale preferito, Scrivi con AI, consegna → consegnato | BO-F1-07 |
| destra: riepilogo AI, prossimi passi, offerta, appuntamento | BO-F1-06 |

## 06 Pipeline

| Voce dell'inventario | Storia |
|---|---|
| viste Kanban/Lista, ricerca, filtri, Azzera, riepilogo, previsione AI | BO-F2-01 |
| card con referente/valore/probabilità/chiusura/azione AI, drag & drop | BO-F2-01 |
| stati predefiniti (In attesa, Chiuse vinte, Pagate, Chiuse perse, Rinnovi) | BO-F2-01 (Q-K1) |
| personalizza stati (tipi, elimina solo se vuoto, + stato, suggerimento AI) | BO-F2-02 |
| dettaglio offerta Panoramica | BO-F2-01, BO-F2-03 |
| costruttore preventivo (catalogo, S Stripe, quantità, suggerimenti AI, sconto, IVA, regola 20k€, Stripe acconto 30%, versioni, PDF) | BO-F2-03, BO-F2-06 |
| Attività dell'offerta | BO-F2-03 |

## Catalogo prodotti

| Voce dell'inventario | Storia |
|---|---|
| import/sync Stripe; fonte prezzi con prezzi bloccati; invito senza Stripe | BO-F2-05 |
| tabella (codice, categoria, prezzo, sconto max, quantità, fonte, attivo) | BO-F2-05 |
| etichette sconto quantità; filtri categoria; ricerca | BO-F2-05 |
| regole di prezzo (sconti auto, ok sopra max, IVA) | BO-F2-04 |
| Aggiungi prodotto: import AI da PDF/Excel/foto oppure manuale | BO-F2-07 |

## 07 Calendario

| Voce dell'inventario | Storia |
|---|---|
| settimana team, colori, filtro persone, riga ora | BO-F3-01 |
| dettaglio evento (chi, dove, origine, sync, link cliente) | BO-F3-01 |
| Fissa con frase (slot tratteggiati, conferma, invito) | BO-F3-02 |
| link prenotazione online | BO-F3-02 |
| Nuovo appuntamento doppia opzione | BO-F3-02 |

## 10 Sequenze

| Voce dell'inventario | Storia |
|---|---|
| elenco con stato e metriche | BO-F3-03 |
| trigger/stop alla risposta; passi giorno+canale; personalizzazione AI | BO-F3-03 |
| avviso permesso; persone con stati; pausa/riattivazione | BO-F3-03 |

## 09 Reporting

| Voce dell'inventario | Storia |
|---|---|
| bundle `reporting@1.2.0` separato, generato dall'agente di coding | BO-F5-01, BO-F5-02 |
| filtri periodo/persona con ricalcolo | BO-F5-02 |
| indicatori (clienti, preventivi, appuntamenti, follow-up, call) | BO-F5-02 |
| grafici (canali, percorso preventivi, appuntamenti, follow-up, call) | BO-F5-02 |
| previsione verso obiettivo (chiuse, probabili, best, linea) | BO-F5-02 |
| tabella Team e vendite | BO-F5-02 |
| Cosa noto AI con ridistribuzione lead | BO-F5-02 |
| struttura bundle + prompt; export CSV | BO-F5-01, BO-F5-02 |

## 08 Spazi e accessi

| Voce dell'inventario | Storia |
|---|---|
| spazi separati, Apri, Nuovo spazio doppia opzione | BO-F0-06 |
| team con ruoli, calendario, canali di risposta; Invita doppia opzione | BO-F0-06 |
| 5 permessi AI (duplicati, bozze, invio, appuntamenti, offerte) | BO-F0-06 |

## Principi trasversali

| Voce dell'inventario | Storia |
|---|---|
| sistema visivo Admin | BO-F0-01 |
| colori = autorità | BO-F0-01 |
| AI propone / persona approva | ogni storia F1–F3, BO-F0-04 |
| doppia opzione di creazione | BO-F0-02, BO-F1-06, BO-F2-07, BO-F3-02, BO-F5-01 |
| sync bidirezionale con evidenza | BO-F1-03, BO-F1-06, BO-F3-01 |
| moduli nativi vs personalizzati | BO-F5-01 |
| fonti nelle risposte AI | BO-F0-04, BO-F4-04 |
| italiano, testi brevi, <700px | BO-F0-01, BO-F0-02 |

## Scarti espliciti (dal prototipo al repo: cosa NON entra)

Questi elementi del prototipo sono simulati per dichiarazione del brief
(sezione "Cosa nel prototipo è simulato") e non diventano codice né dati:

- Dati demo (clienti, listino, prodotti Stripe, trascrizioni, arricchimenti,
  numeri e previsioni): restano fuori dal repo. Le storie lavorano solo su
  record reali o adapter finti dichiarati. Motivo: niente dati finti nel
  framework.
- Timer che simulano approvazioni, invii, sync, OAuth e importazioni:
  sostituiti dai flussi reali (BO-F1-02, BO-F1-03, BO-F1-07). Motivo: il timer
  non è una prova.
- Risposte AI scritte a mano nel prototipo: sostituite dal LLM scelto in Q-L1.
  Motivo: il testo scritto a mano non scala e non cita fonti vere.
- Regole di prezzo come interruttori non applicati: sostituite da valutazione
  reale nel pacchetto (BO-F2-04). Motivo: un interruttore che non blocca è una
  promessa falsa.
- "Crea con l'AI" che non genera bundle: diventa generazione reale solo con
  il formato deciso in Q-K4 (BO-F5-01). Motivo: niente codice generato non
  installabile.
- Sintassi pseudo-codice della definizione skill: non entra in nessun formato;
  va allineata al vero formato del kernel (BO-F4-02, Q-K4). Motivo: due
  formati divergono al primo uso.
- Schermata `account` di `startScreen` senza `data-screen-label`: non coperta
  finché il prototipo non la definisce (Q-P1). Motivo: niente storie su
  elementi che non esistono nel prototipo.
