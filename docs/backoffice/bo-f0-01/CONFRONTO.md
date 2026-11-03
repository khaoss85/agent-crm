# BO-F0-01 Sistema visivo condiviso — prova PNG prima/dopo, 03/11/2026

Voce `backlog:65891147` (segue khaoss85/agent-crm#279, mergiata come
`36203d11`). La #279 aveva solo codice + test; questa PR aggiunge la prova
visiva che il verificatore aveva chiesto (AC-3).

Render: `node scripts/bo-shots.js --screen componenti --screen oggi` su
agent-crm main `8fe6435a`, dati demo dello script (spazio «Studio Aurora»,
utente Elena Rinaldi). Sonda di pittura passata su tutti e quattro i render.

File in questa cartella (4 PNG, tutti render veri con dati demo dipinti):

- `componenti-1440x1800.png`, `componenti-390x1600.png`: il catalogo dei
  componenti, sezione «Badge per autorità» con i sei badge (viola agente,
  giallo regola, corallo persona, ciano evidenza, verde accordo, rosso
  solo guasti).
- `oggi-1440x1800.png`, `oggi-390x1600.png`: una schermata Admin esistente
  (Oggi) con gli stessi token: carta, sidebar, testi, CTA.

Prima/dopo, sui fatti (non sui pixel):

1. I valori dei token di autorità in `apps/admin/public/styles.css` (`:root`)
   sono identici tra la #279 (`36203d11`) e questa testa: `--agent #7457ff`,
   `--pending #f2c84b`, `--human #ff6b69`, `--data #20b8d8`,
   `--accord #27b64a`, `--danger #a23636`, `--paper #f7f3e9`. Nessuna deriva
   di tinta dopo la #279.
2. Le sei regole `.badge[data-authority=...]` sono invariate dalla #279
   (diff vuoto sul selettore), e `tests/admin-authority-tokens.test.js` è
   invariato: la fonte unica (`styles.css` + `site/brand.json`) e il
   significato fisso di ogni colore sono ancora fissati dal test.
3. I quattro PNG mostrano le schermate dipinte con quei token: nessun
   restyle dei token, nessuna regressione visiva attribuibile a F0-01.

Cosa questa prova NON copre: i restyle di layout arrivati dopo la #279
(storie F6, voci dedicate con le loro PNG) cambiano le viste, non i token.
Un confronto pixel col prototipo di ottobre non è dichiarato qui: i token
sono gli stessi, le viste sono andate avanti per le voci F6.
