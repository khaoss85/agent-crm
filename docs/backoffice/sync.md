# Stato sync (/bo) — voci funzionali e test che le provano

Schermata «03 Stato sync» del prototipo: hero con indicatore, card gialla
del permesso in scadenza, card viola dei duplicati, tabella Canali a 9
righe, feed tempo reale, errore gentile con Riprova.
Riferimenti: `docs/backoffice/ROADMAP.md` (BO-F1-03, BO-F1-04),
`docs/backoffice/COVERAGE.md` (§ «03 Stato sync»),
`docs/backoffice/verifica-2026-10-29/CONFRONTO.md` (sezione Stato sync).
Mappa dei numeri C<n> come dichiarata in khaoss85/agent-crm#415.

Vincoli del supervisore (ANSWER 28/10 e 29/10): il vestito visivo (CSS in
`apps/admin/public/styles.css`, spaziature, larghezze, scala dei titoli,
colori, card, shell) lo fa il supervisore. Qui solo parti funzionali,
markup minimo, testi italiani esatti del prototipo. Niente `styles.css`
né `admin-shell.js` toccati da queste voci. PNG 1440/390 con `bo:shots`
e confronto punto per punto: supervisore (job shots della CI).

## Mappa voce → test

| # | Voce funzionale | Stato | Test che la prova |
|---|---|---|---|
| 1 | Hero: titoli «Quasi tutto sincronizzato» / «Tutto sincronizzato» / «Sincronizzazione in corso», sottotitolo «Ultimo aggiornamento <tempo> · <n> eventi ricevuti in tutto» (C9/C10/C11/C15) | Fatta (#371, #415; etichetta cumulativa onesta in questa PR) | `tests/admin-sync.test.js`: «indicator is ok with a count and fix…», «syncing keeps the count…», «the screen renders indicator, fixes, table and feed…», «the ok screen says nothing is broken…» |
| 2 | «Sincronizza ora» globale: un passaggio per connessione sincronizzabile, spinner, doppio clic ignorato, errore con causa e bottone riusabile (C9/C10/C11/C15) | Fatta (#371, #415) | `tests/admin-sync.test.js`: «the hero pull updates every syncable connection…», «Sincronizza ora pulls once per click…», «a failed pull toasts the cause…», «a successful pull releases the guard…» |
| 3 | Card gialla dal `grantExpiresAt` vero: titolo/descrizione del prototipo, «Rinnova in un clic» apre il dettaglio connettore con `?binding=<connectionKey>` della card (C12/C13) | Fatta (#415, questa PR) | `tests/admin-sync.test.js`: «grant expiry reads whole days…», «the yellow grant cards use the prototype wording…», «the yellow card renews through the connector detail», «the yellow grant card names its binding…» |
| 4 | Rinnovo nel dettaglio: «Rinnovo del permesso» con la stessa scadenza della card, registra la scadenza detta dal provider con `renew-connection-grant` sul binding della card (con due binding attivi rinnova quello chiesto, mai il primo), nascosto agli osservatori (P2 Codex su #415; P1 review su #539) | Fatta (questa PR) | `tests/admin-connector-detail.test.js`: «the renewal section only fires…», «the detail records a renewal…», «a channel-level renewal renews the binding the card named…», «the detail route carries the card binding…», «the observer watches the renewal…»; `tests/admin-sync.test.js`: «the grant wording names one shared deadline» |
| 5 | Card viola per ogni duplicato irrisolto: titolo dai nomi reali, «Sì, tienili entrambi» via record action esistente / «Decido io» in coda qualità (C14) | Fatta (#415) | `tests/admin-sync.test.js`: «the purple identity cards name people…», «keep-both dismisses through the record action…» |
| 6 | Lettura candidati `filter.status=unresolved&limit=100` sul server: una storia oltre il limite non nasconde una decisione aperta (P2 Codex su #415) | Fatta (#502) | `tests/admin-sync.test.js`: «the candidates read narrows to unresolved on the server» |
| 7 | Lettura candidati fallita onesta: «Le decisioni sulle doppie schede non si sono potute leggere. Riprova più tardi.», mai il banner «Niente da sistemare»; 404/UNSUPPORTED_CONTRACT restano silenzio a zero card (P2 Codex su #415) | Fatta (#502) | `tests/admin-sync.test.js`: «a failed candidates read stays honest…», «an uncomposed candidates module stays silent…» |
| 8 | Tabella Canali: 9 righe fisse con direzioni del prototipo, colonna «Aggiornamento» con «agg. …», colonna «Eventi» cumulativa, pill `Attivo`/`Permesso in scadenza`/`Importazione`, conteggio «<n> di 9 collegati» (C16-C20/C27) | Fatta (#415; etichetta cumulativa in questa PR) | `tests/admin-sync.test.js`: «channel table carries the last outcome…», «the Canali card lists the nine fixed prototype channels», «the channel table aggregates one row per fixed channel», «the channel pill names expiry and import…», «the table renders nine rows with the count, agg and pills», «the empty space still lists nine connectable rows» |
| 9 | Solo i canali del catalogo hanno «Collega» verso il dettaglio con flusso; Google Calendar e Stripe dicono «Non disponibile» e tornano a #/connettori, mai al vicolo cieco «Connettore sconosciuto» (P2 Codex su #415) | Fatta (questa PR) | `tests/admin-sync.test.js`: «only catalogued channels have a detail flow»; `tests/admin-connector-detail.test.js`: «an unknown channel renders honestly without fetching for it» |
| 10 | Feed con orologio di Roma `hh:mm:ss`, frecce ←/→, legenda invariata, vuoto gentile «Nessuna attività sincronizzata oggi.» (C21/C22) | Fatta (#415) | `tests/admin-sync.test.js`: «feed lists newest-first events…», «the live feed reads the Rome clock, never UTC» |
| 11 | Errore gentile con «Riprova», sola lettura per l'Osservatore (azioni nascoste + riga di spiegazione) (C28) | Fatta (#415) | `tests/admin-sync.test.js`: «a failed read offers Riprova and retries on click», «the observer watches without touching», «the view degrades honestly…» |
| 12 | Testi italiani onesti su valori ignoti, mai etichette tecniche («follow-up · task-1», NOT_FOUND, undefined); testo ostile resta testo, mai markup | Fatta (#415) | `tests/admin-sync.test.js`: «labels stay Italian and honest on unknown values», «hostile server text stays text, never markup» |
| 13 | Niente controlli grezzi: ogni bottone/campo visibile usa una classe `ui-*` | Fatta (#415) | `tests/admin-sync.test.js`: «every control on the screen carries the visual-system classes» |
| 14 | Shell (C1/C2/C5/C7: tab, badge, breadcrumb, placeholder AI) e layout (C23-C26) | Non applicabile a queste voci: vestito del supervisore | PNG e confronto del supervisore (job shots della CI) |
| 15 | Numeri C3/C4/C6/C8: non descritti in nessuna PR consegnata (#371, #415, #502, questa); la spec originale non è più nell'handoff | Non applicabile (motivata): tutti i comportamenti del prototipo in `COVERAGE.md` (03 Stato sync) sono coperti dalle righe 1-13 sopra | — |

## Resta al supervisore (vestito, non in questa PR)

- Bottoni «Collega» pieni scuri e posizione di «1 di 9 collegati» (CONFRONTO.md 29/10: solo CSS).
- PNG 1440/390 con `bo:shots` e confronto punto per punto col prototipo.
- La colonna «Aggiornamento» («agg. …») c'è già nel markup (riga 8): la forma tabellare è CSS.

## Decisioni (da confermare)

- DECISION (to be confirmed): senza contatore giornaliero nel payload, l'hero e le righe dicono «eventi ricevuti in tutto» invece di «sincronizzati oggi», perché un numero cumulativo spacciato per giornaliero sarebbe disonesto. Il contatore giornaliero reale resta un follow-up (serve un predicato di intervallo nel record runtime).
- DECISION (to be confirmed): «Rinnova in un clic» apre il dettaglio invece di rinnovare da solo, perché il rinnovo vero vive nel flusso guidato del connettore con la scadenza detta dal provider (`renew-connection-grant`), mai inventata.
