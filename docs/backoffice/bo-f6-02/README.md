# BO-F6-02 — Prova PNG: catalogo, Oggi e Connettori (backlog:c8364e59)

Dopo: render `npm run bo:shots` sul runner accordo-ci (unico Chromium
funzionante), dati demo, viewport DESKTOP 1440x1800 e PHONE 390x1600.
Run CI: 40587976021 (pull_request) e 40588777387 (workflow_dispatch),
testa minimal/c8364e59-png-proof (continua #372, mergiata come 9c3adcda).
I PNG sono raccolti dal temp del runner perche l'upload artifact perde i
file per quota account piena; sono i render genuini dell'harness di progetto
sulla testa della PR, non schermate ritoccate.

Prima: riferimento vincolante del prototipo (NON nel repo: agent-crm e
pubblico, regola della voce):
`_handoff/accordo-backoffice-design/shots-2026-10-24/`
`oggi-desktop.png`, `oggi-phone.png`, `connettori-desktop.png`,
`connettori-phone.png`.

## Catalogo (AC-2)

`componenti-1440x1800.png`, `componenti-390x1600.png`: la pagina
`admin-ui-catalog.js` (createUiCatalogView) mostra tutti i componenti della
voce — primario scuro, CTA verde, secondario, scheda sottolineata,
segmentato I tuoi/Scopri, chip IG/WA/TEL/@/CAL/S/FB/TT/WEB, card, tabella,
ricerca con icona, tendina, interruttore, badge per autorita, toast, stato
vuoto. Pagina nuova: non ha un prima.

## Oggi (AC-3)

Prima: saluto grande + data, frase di riepilogo, card advisor con chip di
canale, riga viola ✦ di suggerimento e CTA scuro a destra, agenda e brief
viola affiancati.
Dopo (`oggi-1440x1800.png`, `oggi-390x1600.png`): stessa struttura e ordine
delle aree, stessi componenti (chip WA/TT/S/CAL, Domani secondario,
Completa/Apri scheda primario scuro, card, agenda, brief).
Differenze motivate:
1. Dati demo diversi (palestra vs Studio Aurora): fixture dell'harness.
2. Niente riga viola ✦ né brief in tinta: contenuto dei fixture, storia
   Oggi (BO-F6-07) — qui conta che non ci sono controlli grezzi (test
   `no raw control` verde).
3. Shell laterale diversa: storia BO-F6-01, fuori perimetro.

## Connettori (AC-3)

Prima (`connettori-desktop.png`, tab Connettori in Personalizzazione): hero
scuro Kit social, due sezioni di card canale con chip + stato, CTA verde
Aggiungi, ricerca.
Dopo (`connettori-1440x1800.png`, `connettori-390x1600.png`): schermata
dedicata con card Canali (una riga per canale come i Collegamenti Google:
badge, nome, descrizione, chip di stato, Collega; la riga apre il dettaglio),
senza campo Spazio né Ricarica — tutto con le classi del sistema
(test `the connectors view renders no raw control` verde).
Differenze motivate:
1. Schermata dedicata sotto Impostazioni invece di tab: IA della shell
   (BO-F6-01).
2. Card con passi di collegamento invece di tick di stato: contenuto delle
   storie F4, componenti identici.
3. Hero Kit-social e chip sulle card non riprodotti: gap di contenuto gia
   registrato come follow-up P3 (parita contenuto prototipo
   Personalizzazione/Connettori).
