# Backoffice Accordo — Domande aperte

Voce `e2f1dfa0078b`. Dove il prototipo e il codice esistente sono in
conflitto, non si sceglie da soli (regola del brief). Sotto: i conflitti
trovati verificando il prototipo contro `main` (commit `eb2e946`), più le
domande che il brief chiede di portare all'owner.

## Conflitti prototipo / codice

### Q-P1 — `startScreen: account` non esiste nelle schermate

Il prop `startScreen` elenca `account`, ma nessun elemento del file ha un
`data-screen-label` per l'account (le etichette sono solo "00"–"11").
Domanda: cos'è la schermata account (profilo utente? fatturazione?) e con
quale etichetta va referenziata? Finché manca, nessuna storia la copre
(vedi scarti in `COVERAGE.md`).

### Q-P2 — Chi possiede Spazi, team e inviti

La schermata "08 Spazi e accessi" crea spazi, invita persone con ruoli e
canali, assegna i 5 permessi AI per spazio. Nel framework i record sono già
space-scoped (`channel-connection` lega spazio e account), ma provisioning
degli spazi e Blueprint vivono nel control plane (`accordo-platform`), non in
questo repo. Domanda: la gestione spazi del backoffice chiama il control
plane via API o il framework riceve un modello spazi proprio? Senza risposta,
BO-F0-06 resta solo interfaccia sopra record esistenti.

### Q-K1 — Stadi della pipeline: prototipo vs `accordo-sales`

Il prototipo dichiara stadi predefiniti: In attesa, Chiuse vinte, Pagate (da
Stripe), Chiuse perse, Rinnovi in scadenza. Il framework ha `accordo-sales`
in `packages/pipelines` (opt-in per spazio, cinque stadi propri, contratto 1).
Domanda: gli stadi del backoffice ridefiniscono `accordo-sales`, ne sono una
configurazione per spazio, o una pipeline separata? BO-F2-01 parte dalla
configurazione per spazio finché non si decide.

### Q-K2 — Chi può ridefinire gli stadi

"Personalizza stati" (rinomina, riordina, colore, tipo, elimina solo se
vuoto) contraddice la definizione pipeline code-first e revisionabile del
framework. Domanda: la personalizzazione è una configurazione per spazio
validata contro i 5 tipi, o resta code-first e il backoffice propone ma non
applica? BO-F2-02 assume la prima, con eliminazione rifiutata se non vuoto.

### Q-K3 — Dove vive il motore delle Sequenze

Nessun pacchetto sequenze esiste (`packages/` non ne ha alcuno). Candidati:
nuovo pacchetto nativo sopra `packages/work` (timer) + `packages/channels`
(outbox), oppure estensione di un pacchetto esistente. Domanda: nuovo
pacchetto o riuso esteso? BO-F3-03 assume un motore nuovo con fail-closed
senza permesso di invio.

### Q-K4 — Formato canonico delle skill e dei bundle

Il brief lo segnala da solo (⚠ pseudo-codice) e lo conferma la verifica: la
definizione "Nel tuo progetto Accordo" non corrisponde a nessun formato del
kernel (pacchetto nativo + capability dichiarata, `docs/PACKAGE_AUTHORING.md`;
moduli in `packages/modules`). Domanda: qual è il formato canonico che il
dettaglio skill mostra e che l'agente di coding genera per i bundle
personalizzati? Finché manca, BO-F4-02 e BO-F5-01 mostrano solo il contratto,
non la sintassi.

### Q-C1 — Limiti reali delle API di canale

Il prototipo dà per scontati WhatsApp, Instagram, Facebook, TikTok, Email,
Telefono, Google Calendar e Stripe sempre disponibili. Il framework sviluppa
contro adapter finti e le credenziali vere non esistono ancora (decisione
owner MEM_ACC_DECISIONS). Domanda: per ogni canale, quali limiti contano per
la roadmap (approvazione app Meta, finestra 24h, quote Google, solo-in-entrata
TikTok)? BO-F1-01 isola ogni canale dietro il contratto adapter proprio per
questo.

## Domande del brief (da decidere con l'owner)

### Q-L1 — Quale LLM per assistente, Advisor e domande libere

Il prototipo usa risposte scritte a mano + "un vero LLM" per le domande
libere. Domanda: quale modello, con quali limiti di costo e latenza, e dove
gira (chiavi di chi, dati dei clienti a quale provider)? Blocca BO-F0-04 e
tutte le funzioni "Scrivi/Suggerisci con AI".

### Q-G1 — GDPR sull'arricchimento e sull'unione di identità

"Arricchito dall'AI" estrae dati dalle conversazioni; il collegamento
unisce identità da più canali. Domanda: quali basi giuridiche e quali
conservazioni per Presti Group (informativa? opt-out? cancellazione su
richiesta)? Blocca BO-F1-04, BO-F1-06, BO-F4-03 sul dato vero.

### Q-G2 — Consenso alle registrazioni delle chiamate

Trascrizione + segnali presuppongono chiamate registrate. Domanda: come si
raccoglie e dove si registra il consenso (due parti? solo avviso?),
e quanto si conserva la trascrizione? Blocca BO-F1-08.

### Q-C2 — Soglia 20.000 € e ruoli: chi è "la titolare"

La regola di approvazione nomina "la titolare". Domanda: è un ruolo per
spazio (chi lo ha? cosa succede senza?) o una persona nominata? E acconto
sempre 30%? Blocca il dettaglio di BO-F2-06.

## Ispirazioni dichiarate (adattare, non copiare)

Il brief cita la pagina Personalizzazione di Claude e funzioni di Attio (call
intelligence, reporting, enrichment, universal context, sequences). Scelta
documentata qui come `DECISION (to be confirmed)`: si riusano i concetti
attraverso i pacchetti esistenti (`packages/intelligence`, `packages/analytics`,
`packages/customer-data`) senza copiare interfacce né testi. Se l'owner
preferisce un'altra attribuzione, si cambia senza toccare le storie.
