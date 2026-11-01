# Login /bo — confronto punto per punto col prototipo, 01/11/2026

Render: PNG resi dalla CI `bo-shots` sul runner self-hosted per il branch
`minimal/5acdfd87-login` (workflow_dispatch run 40775943607, PR #414):
`login.html` + `login.js` byte-identici da allora (`sha256 login.html =
e03cb839f27a4ed6234570ca40bc4a74bf6b1c8864d59a88c042bce3d9c62b64`),
quindi i PNG ritraggono l'albero di oggi (main `4e0816d9`). Sonda di
pittura passata su quel render (`assertProbe` login: magic form, campo
email, bottone Google, pannello racconto, enhancement #408); gate delle
prove verde oggi (`tests/bo-shots-proof.test.js`). Copie di oggi in questa
cartella, byte-identiche alle fixture `tests/fixtures/bo-shots-proof/`.
Riferimento: prototipo «Accordo Backoffice 2026-10-24» login-desktop/phone
e `docs/backoffice/verifica-2026-10-29/CONFRONTO.md` §Login (UGUALE + 1
nota da controllare, chiusa al punto 4 sotto).

Esito: UGUALE al prototipo, confermato oggi pixel per pixel. Nessuna
differenza restante.

1. Struttura a due colonne: racconto scuro a sinistra, accesso a destra —
   come il prototipo.
2. Marchio con cerchio a quattro colori + testo «Accordo» nella riga del
   logo (pin C2, `tests/admin-login.test.js`).
3. Titolo «Ogni conversazione, un solo cliente.» + riga «Instagram, email,
   telefono e WhatsApp confluiscono in un'unica scheda. L'AI tiene il
   filo, tu decidi.» — testi fissi, come il prototipo.
4. Filo di 4 messaggi sfalsati (IG «Fate anche consulenze a Milano?» ven,
   @ «Info ristrutturazione cucina» 09:10, TEL «Chiamata in entrata · 6:12»
   09:47, WA «Giovedì alle 15 va benissimo!» 10:20) + card «Giulia Romano /
   Prima call giovedì 15:00 con Marco» con avatar GR e dot verde: visibili
   a 1800 px di altezza nel PNG 1440. CHIUDE la nota del 29/10 («filo
   sotto la piega, da controllare»): il filo c'è e si vede.
5. Destra: occhiello mono «ACCEDI», «Bentornata», riga «Ritrova clienti,
   conversazioni e agenda del team dove li hai lasciati.» — come il
   prototipo.
6. «Continua con Google» secondario verso `/auth/google` (voce del
   deployment, nessun client nel framework: test di scansione
   `Google sign-in stays deployment-owned`).
7. «oppure», etichetta «Email di lavoro», campo email con placeholder demo
   `elena@studioaurora.it` (mai un value), `maxlength 200`, `required`,
   `type email` — come il prototipo.
8. CTA verde «Ricevi il link di accesso», vero `type submit` (Invio manda:
   pin C17) — come il prototipo.
9. Nota «Niente password: ti inviamo un link valido 10 minuti.» — come il
   prototipo.
10. «Nuovo su Accordo? Crea uno spazio gratuito» — come il prototipo.
11. A 390: colonna unica, racconto sopra e form sotto, nessun scorrimento
    orizzontale; le righe del filo usano l'ellissi di disegno (stesso CSS
    del desktop), nessun dato perso.
12. Nessun controllo senza classe `ui-*` (test `every login control rides
    the visual system`).
13. Comportamento: controlli disabilitati durante l'invio, guida in
    italiano su input vuoto/errato, conferma «10 minuti» dopo l'invio,
    nota di riprova su rifiuto/errore (test, slice 2 #408).
