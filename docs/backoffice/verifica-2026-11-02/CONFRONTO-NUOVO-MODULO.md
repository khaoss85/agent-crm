# Nuovo modulo /bo — confronto punto per punto col prototipo, 02/11/2026

Render: `CHROMIUM_BIN=/Users/danielepelleri/.local/bin/chromium-server
node scripts/bo-shots.js --screen nuovo-modulo` su agent-crm main `f350b580`,
dati demo dello script (spazio «Studio Aurora», utente Elena Rinaldi).
Sonda di pittura passata su entrambi i render. I byte dei PNG sono identici
alle fixture `tests/fixtures/bo-shots-proof/nuovo-modulo-*.png` (fresche dal
#544): nessun restyle dopo il merge della #332.

Riferimento: prototipo «Accordo Backoffice 2026-10-24» come descritto nella
#447 (design pass 6, tabella Ingresso/Tendina/Modulo/Dettagli), che non ha
uno schermo dedicato al modulo: il confronto riusa quella tabella.

Esito: come il prototipo su tutti i 4 punti della #447, a 1440 e a 390.
Nessuna divergenza da aprire come voce fix.

1. Ingresso → solo il pulsante tratteggiato «+ Nuovo modulo» sotto
   MODULI PERSONALIZZATI, nessuna voce di menu dedicata. Come il prototipo.
2. Tendina → tessera viola «Crea con l'AI» («Descrivi il modulo, il tuo
   agente di coding lo genera come bundle separato») e tessera matita
   «Compila manualmente» («Nome, dati usati e chi può vederlo»).
   Come il prototipo. Il manuale apre `#/nuovo-modulo`, nessun comando
   da terminale in vista.
3. Modulo → kicker «Moduli personalizzati», titolo «Nuovo modulo
   personalizzato», sottotitolo sul bundle separato dal kernel, 4 domande
   (Nome del modulo, Cosa deve mostrare o fare, Dati usati, Chi può
   vederlo), «✦ Preferisco farlo con l'AI» a sinistra, CTA verde
   «Genera il modulo» a destra. Come il prototipo, come scheda di pagina
   (il backoffice non ha un componente modale).
4. Dettagli tecnici → chiusi in «Per chi sviluppa: il manifest e i comandi».
   Come il prototipo (dettagli assenti dalla vista).
5. Navigazione italiana → breadcrumb «STUDIO AURORA / NUOVO MODULO»,
   barra AI «Descrivi…» con ⌘K, utente e ruolo in basso. Come le altre
   schermate verificate.
6. A 390 la pagina è a colonna unica, card impilata, nessun scorrimento
   orizzontale; la tendina resta leggibile sopra il contenuto.
   Nessun controllo grezzo senza classe `ui-*` (gate già verde in CI).

Parte Reporting della voce: riusata senza duplicati (MEM_ACC_REUSE) —
`docs/backoffice/verifica-2026-11-01/CONFRONTO-REPORTING.md` con
`reporting-1440x1800.png` e `reporting-390x1600.png` (#536), più fixture
fresche `tests/fixtures/bo-shots-proof/reporting-*.png` (#544). Nessun
cambio a `admin-reporting.js` dopo quei render: il gate
STALE_REPORTING_BLOBS resta verde su questa testa.
