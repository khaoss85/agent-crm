# Accordo — Master JTBD, Use Case & Coverage Document

> Documento desired-state per progettazione, audit del repository, roadmap e benchmark di Accordo.  
> Versione `2026-08-20.1`. La copertura implementata è separata e parte da `NOT_ASSESSED`.

## Indice

1. Overview
2. Metodo
3. Personas
4. Capability map
5. Catalogo JTBD
6. Coverage model
7. Roadmap e benchmark
8. Known evidence seed
9. Reference architecture
10. Epic taxonomy
11. Scenari end-to-end

---



---

<!-- SOURCE: README.md -->

# Accordo — JTBD & Use Case Coverage System

**Versione catalogo:** `2026-08-20.1`  
**Lingua:** italiano  
**Ambito:** Customer Database, CDP, CRM evoluto, intelligent automation e agentic CRM  
**Dimensione:** **30 ruoli**, **600 JTBD/use case**, **225 capability atomiche**

## Obiettivo

Questo repository-documento è una specifica di prodotto e un sistema di verifica. Serve a:

1. simulare adozione, uso quotidiano, ottimizzazione, manutenzione, governance ed evoluzione di Accordo;
2. rendere confrontabili bisogni di executive, manager, frontline, marketing, customer, data, engineering, governance e finance;
3. permettere a Codex, Claude Code o a un reviewer umano di verificare la copertura sul codice senza confondere requisito e implementazione;
4. trasformare gap dimostrati in roadmap, epic, specifiche tecniche e test;
5. supportare benchmark competitivo con evidenze datate, non con impressioni.

## Principio fondamentale

`JTBD desiderato != capability richiesta != feature implementata != feature production-ready`

Il catalogo descrive il **desired state**. Tutti gli status di copertura partono da `NOT_ASSESSED`. Una feature può essere dichiarata coperta solo con evidenze sullo **SHA target**: file, simbolo/linea, route/API, workflow, UI, test eseguito, policy e telemetry.

## Percorso di lettura

| Ordine | File | Uso |
|---:|---|---|
| 1 | `AGENTS.md` | Contratto operativo per Codex/Claude Code |
| 2 | `docs/00_methodology.md` | Tassonomia, lifecycle, autonomia e scoring |
| 3 | `docs/01_personas.md` | Missione, KPI, decisioni e scope dei 30 cappelli |
| 4 | `docs/02_capability_map.md` | Mappa atomica delle capability |
| 5 | `docs/03_jtbd_catalog.md` | Catalogo umano dei 600 JTBD |
| 6 | `data/jtbd.jsonl` | Source of truth machine-readable |
| 7 | `docs/04_coverage_model.md` | Rubrica e protocollo di audit |
| 8 | `prompts/01_repo_coverage_audit.md` | Prompt pronto per audit del repository |
| 9 | `docs/05_roadmap_and_competition.md` | Conversione gap→roadmap e benchmark |
| 10 | `docs/06_known_accordo_evidence_seed.md` | Indizi pregressi da riverificare sul repository |

## File principali

- `data/jtbd.jsonl`: un oggetto JSON completo per ciascun JTBD.
- `data/jtbd.csv`: vista piatta importabile e filtrabile.
- `data/traceability_jtbd_capability.csv`: relazione molti-a-molti JTBD↔capability.
- `data/capabilities.json`: registro capability.
- `data/personas.json`: registro ruoli.
- `data/coverage_*.template.jsonl`: output contract dell'audit.
- `data/roadmap_backlog.template.csv`: backlog iniziale, da valorizzare dopo l'audit.
- `data/competitor_benchmark.template.csv`: griglia di benchmark senza claim precompilati.
- `schemas/*.json`: JSON Schema.
- `tools/*.py`: validazione, inizializzazione copertura e scoring roadmap.
- `Accordo_JTBD_Catalog.xlsx`: workbook per review umana.
- `Accordo_JTBD_Master.md`: documento unico leggibile.

## Comandi

```bash
python tools/validate_catalog.py
python tools/init_coverage.py --repo OWNER/REPO --sha TARGET_SHA --out data/coverage_jtbd.assessed.jsonl
python tools/score_roadmap.py --catalog data/jtbd.jsonl --coverage data/coverage_jtbd.assessed.jsonl --out data/roadmap_scored.csv
```

## Regola di utilizzo

Il catalogo è **append-only per gli ID**. Un JTBD già referenziato non va rinumerato: può essere deprecato, sostituito o esteso mantenendo la tracciabilità. Le modifiche sostanziali incrementano `catalog_version` e devono passare `validate_catalog.py`.



---

<!-- SOURCE: docs/00_methodology.md -->

# 00 — Metodo, tassonomia e criteri

## 1. Cosa descrive il catalogo

Il catalogo usa quattro unità distinte:

| Unità | Domanda |
|---|---|
| **Persona/cappello** | Chi prende la decisione o compie il lavoro? |
| **JTBD** | Quale progresso vuole ottenere in una situazione concreta? |
| **Use case** | Quale sequenza di dati, decisioni, azioni ed eccezioni rende possibile il lavoro? |
| **Capability** | Quale capacità atomica e riusabile deve offrire la piattaforma? |

La copertura è una quinta unità separata: misura quanto il repository realizza il requisito su uno SHA preciso.

## 2. Forma canonica del JTBD

Ogni job segue:

> **Quando** [situazione], **voglio** [lavoro], **così da** [outcome].

Il catalogo non usa formule come “voglio una dashboard” salvo che la dashboard sia davvero il lavoro. Una dashboard è normalmente una soluzione; il job è decidere, capire, coordinare, eseguire o governare.

## 3. Lifecycle della piattaforma

| Fase | Significato | Esempi |
|---|---|---|
| `ADOPT` | Introduzione, migrazione, configurazione e allineamento operativo | schema, ruoli, tassonomia, import, baseline |
| `RUN` | Lavoro ricorrente o event-driven | routing, campagne, forecast, case, handoff |
| `OPTIMIZE` | Miglioramento misurato | esperimenti, riallocazione, coaching, tuning |
| `MAINTAIN` | Qualità, affidabilità e continuità | freshness, incident, data quality, versioni |
| `GOVERN` | Decisioni e controlli ad alto impatto | consenso, accessi, eccezioni, audit |
| `EVOLVE` | Nuove capability e aumento dell'autonomia | agenti, integrazioni, marketplace, roadmap |

Distribuzione del catalogo: `ADOPT` 120, `EVOLVE` 60, `GOVERN` 30, `MAINTAIN` 30, `OPTIMIZE` 120, `RUN` 240.

## 4. Pattern di use case

| Pattern | Funzione primaria |
|---|---|
| `CONFIGURE` | Converte requisiti in configurazione versionata e testata |
| `MONITOR` | Osserva segnali, soglie e trend |
| `INVESTIGATE` | Ricostruisce evidenze, cause e impatto |
| `DECIDE` | Confronta opzioni e raccomanda con trade-off |
| `EXECUTE` | Compie azioni idempotenti entro policy |
| `CREATE` | Produce artefatti con fonti, brand e approvazione |
| `OPTIMIZE` | Sperimenta e scala solo dopo verifica |
| `MAINTAIN` | Preserva SLO, qualità e compatibilità |
| `GOVERN` | Applica policy, deleghe e accountability |
| `EVOLVE` | Progetta, testa e rilascia nuove capability |

## 5. Scala di autonomia agentica

| Livello | Descrizione | Autorizzazione tipica |
|---|---|---|
| `L0` | Manuale / record keeping | l'umano decide ed esegue |
| `L1` | Osserva e spiega | sola lettura |
| `L2` | Raccomanda o prepara | l'umano decide/esegue |
| `L3` | Agisce dopo approvazione | mutazione esplicita approvata |
| `L4` | Agisce entro policy e notifica | azioni pre-autorizzate, limite stretto |
| `L5` | Ottimizza/evolve in sandbox | gate umano prima della produzione |

Distribuzione target: `L2` 129, `L3` 471.

`L5` non significa auto-modifica incontrollata in produzione. Significa che l'agente può proporre o generare varianti di prompt, tool, workflow o configurazioni in ambiente isolato; evaluation, policy e approvazione restano obbligatori per la promotion.

## 6. Anatomia di ogni record JSONL

Ogni JTBD contiene:

- ID stabile, persona, gruppo, lifecycle e journey;
- job statement canonico;
- trigger, frequenza, precondizioni, primary flow, eccezioni e output;
- pattern agentico, autonomia, agent role, tool, memory ed evidence contract;
- entità, input, integrazioni e freshness;
- capability core e supporting;
- acceptance criteria e KPI;
- rischio, guardrail, requisiti non funzionali e test obligations;
- scoring iniziale di audit/roadmap;
- oggetto coverage vuoto;
- griglia per benchmark.

## 7. Ruoli inclusi

Il perimetro comprende 30 ruoli in 9 gruppi:

| Gruppo | Ruoli | JTBD |
|---|---:|---:|
| Executive & Strategy | 5 | 100 |
| Revenue Operations | 2 | 40 |
| Product & Platform Operations | 2 | 40 |
| Sales Frontline & Management | 4 | 80 |
| Customer Success & Service | 2 | 40 |
| Partner & Ecosystem | 1 | 20 |
| Marketing & Growth | 6 | 120 |
| Data, AI & Engineering | 5 | 100 |
| Governance & Finance | 3 | 60 |

Sono stati aggiunti ruoli non presenti nella lista iniziale perché indispensabili a un CRM/CDP operativo: RevOps, Customer Success Director, CRM/CDP Product Owner, Marketing Operations, Customer Service Agent, ABM, Product Marketing, Data Scientist, CRM Administrator, Governance/Privacy/Security, Revenue Finance, Deal Desk e Partner Manager.

## 8. Capability map

Le 225 capability sono atomiche e riusabili. Distribuzione:

| Dominio | Capability |
|---|---:|
| Platform Foundation | 18 |
| Customer Data Platform | 22 |
| Sales CRM | 24 |
| Marketing & Growth | 25 |
| Customer Success & Service | 23 |
| Analytics & AI | 28 |
| Workflow & Automation | 18 |
| Governance & Security | 18 |
| Developer Platform | 22 |
| Collaboration & Enablement | 15 |
| Finance & Commercial | 12 |

Una capability non coincide necessariamente con una schermata. Può richiedere data model, service, workflow, agent, UI, integrazioni e controlli.

## 9. Acceptance e non-functional definition of done

Un caso non è “coperto” solo perché esiste il happy path. Ogni record include obblighi per:

- input, freshness e lineage;
- scope, permission e tenant isolation;
- missing/conflicting data e fail-closed;
- idempotenza, retry e compensazione;
- audit, trace, version e evidence;
- KPI e feedback loop;
- per gli agenti: eval set, tool misuse, prompt injection, cost/latency e override.

## 10. Rischio

Distribuzione del catalogo: `HIGH` 123, `LOW` 193, `MEDIUM` 284.

Il rischio non misura soltanto la probabilità di errore; considera impatto economico, legale, reputazionale, operativo e sui dati. Il livello determina autonomy ceiling e approval.

## 11. Scoring iniziale

`audit_priority_score` ordina il lavoro di verifica, non la roadmap finale:

```text
20 × (
  0.30 × BusinessValue +
  0.20 × Frequency +
  0.20 × StrategicFit +
  0.15 × Differentiation +
  0.15 × RiskReduction
)
```

La roadmap richiede anche `coverage_gap_weight`, dipendenze e effort. Un requisito non valutato non deve essere automaticamente trasformato in feature.

## 12. Regole di evoluzione del catalogo

1. ID stabili e non riutilizzabili.
2. Nuovo ruolo: almeno 20 JTBD e tutte le lifecycle pertinenti.
3. Nuovo JTBD: acceptance, capability e guardrail obbligatori.
4. Nuova capability: nome atomico, dominio, descrizione e required evidence.
5. Modifica semantica: incrementare `catalog_version`.
6. Nessun claim competitivo senza fonte e data.
7. Il catalogo desired-state non viene “corretto” per assomigliare al codice corrente: sono i gap a guidare la roadmap.



---

<!-- SOURCE: docs/01_personas.md -->

# 01 — Personas / cappelli operativi

Ogni cappello rappresenta missione, decisioni, KPI, access scope e una prospettiva distinta sulla piattaforma.

## Chief Revenue Officer (`PER-EXEC-CRO`)

**Gruppo:** Executive & Strategy  
**Missione:** Massimizzare crescita efficiente e prevedibile coordinando marketing, sales, customer e finance su un unico sistema di decisione.  

**Decisioni chiave:** allocazione budget e capacità; priorità di segmento e motion; commit revenue; eccezioni di pricing e rischio.  

**KPI principali:** ARR bookings; Net Revenue Retention; Forecast accuracy; Pipeline coverage; CAC payback; Gross margin.  

**Integrazioni tipiche:** Data warehouse; ERP/Finance; Billing; Marketing automation; Sales engagement; Customer success.  

**Scope dati/accesso:** Accesso aggregato cross-funzionale; PII e record-level detail solo per eccezioni autorizzate.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Direttore Marketing / CMO (`PER-EXEC-MKT-DIR`)

**Gruppo:** Executive & Strategy  
**Missione:** Generare domanda e crescita misurabili, orchestrando audience, canali, contenuti e lifecycle fino al risultato economico.  

**Decisioni chiave:** budget e channel mix; priorità audience; portfolio campagne; governance brand e consenso.  

**KPI principali:** Marketing-sourced pipeline; CAC; Cost per opportunity; Incremental revenue; Conversion rate; Brand/deliverability health.  

**Integrazioni tipiche:** Ad platforms; Web analytics; CMS/DAM; Email/SMS; Webinar/Event; Data warehouse.  

**Scope dati/accesso:** Accesso aggregato cross-funzionale; PII e record-level detail solo per eccezioni autorizzate.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Direttore Vendite / VP Sales (`PER-EXEC-SALES-DIR`)

**Gruppo:** Executive & Strategy  
**Missione:** Rendere il motore commerciale prevedibile, produttivo e scalabile, con pipeline di qualità e coaching basato su evidenze.  

**Decisioni chiave:** coverage e territori; quote e capacità; deal strategy; pricing e approvazioni.  

**KPI principali:** Bookings; Quota attainment; Forecast accuracy; Win rate; Sales cycle; Pipeline coverage.  

**Integrazioni tipiche:** Email/Calendar; Sales engagement; Telephony; CPQ; E-sign; Partner portal.  

**Scope dati/accesso:** Accesso aggregato cross-funzionale; PII e record-level detail solo per eccezioni autorizzate.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Direttore Customer Operations (`PER-EXEC-CUST-OPS`)

**Gruppo:** Executive & Strategy  
**Missione:** Offrire un servizio coerente, proattivo ed efficiente lungo l'intero customer journey, riducendo attriti e costo di gestione.  

**Decisioni chiave:** service model; capacità e routing; escalation; automazione e self-service.  

**KPI principali:** First contact resolution; SLA attainment; CSAT; Cost to serve; Escalation rate; Self-service deflection.  

**Integrazioni tipiche:** Support desk; Contact center; Knowledge base; Product telemetry; Billing; Status/incident platform.  

**Scope dati/accesso:** Accesso aggregato cross-funzionale; PII e record-level detail solo per eccezioni autorizzate.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Revenue Operations Director / Manager (`PER-OPS-REVOPS`)

**Gruppo:** Revenue Operations  
**Missione:** Progettare e governare dati, processi, metriche e automazioni che collegano marketing, sales, customer e finance.  

**Decisioni chiave:** source of truth; process design; routing/scoring; release e priorità operative.  

**KPI principali:** Funnel conversion; Routing SLA; Forecast reconciliation; Data quality; Process cycle time; Automation success rate.  

**Integrazioni tipiche:** CRM; Marketing automation; Sales engagement; Customer success; Billing; Data warehouse.  

**Scope dati/accesso:** Accesso operativo cross-funzionale a schema, processi e record; modifiche di configurazione tramite change control.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Direttore Customer Success (`PER-EXEC-CS-DIR`)

**Gruppo:** Executive & Strategy  
**Missione:** Massimizzare adozione, valore, retention ed expansion con un modello Customer Success scalabile e predittivo.  

**Decisioni chiave:** segmentazione e coverage; health model; risk/renewal plays; capacity e portfolio.  

**KPI principali:** Gross retention; Net revenue retention; Time to value; Product adoption; Renewal forecast accuracy; Expansion ARR.  

**Integrazioni tipiche:** Product analytics; Support desk; Billing; Learning platform; Survey/NPS; Data warehouse.  

**Scope dati/accesso:** Accesso aggregato cross-funzionale; PII e record-level detail solo per eccezioni autorizzate.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## CRM/CDP Product Owner (`PER-PROD-CRM-PO`)

**Gruppo:** Product & Platform Operations  
**Missione:** Trasformare bisogni e JTBD in una piattaforma coerente, adottata, verificabile e progressivamente più agentica.  

**Decisioni chiave:** priorità backlog; configurazione vs custom; scope release; acceptance e rollout.  

**KPI principali:** Outcome adoption; Time to value; Release predictability; Capability coverage; Defect escape rate; Roadmap value delivered.  

**Integrazioni tipiche:** GitHub/CI; Product analytics; Support/request intake; Design system; Data catalog; Feature flag platform.  

**Scope dati/accesso:** Accesso a configurazioni e telemetry; promozione in produzione solo tramite gate e audit.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Marketing Operations & CRM Manager (`PER-OPS-MKT-OPS`)

**Gruppo:** Revenue Operations  
**Missione:** Rendere eseguibili, misurabili e affidabili campagne, lifecycle e handoff attraverso dati e automazioni governate.  

**Decisioni chiave:** configurazione campagne; tassonomie; consenso e suppression; release martech.  

**KPI principali:** Campaign cycle time; Lead routing SLA; Data completeness; Deliverability; Attribution coverage; Automation failure rate.  

**Integrazioni tipiche:** Marketing automation; CMS/Landing; Ad platforms; Web analytics; Webinar/Event; CRM.  

**Scope dati/accesso:** Accesso operativo cross-funzionale a schema, processi e record; modifiche di configurazione tramite change control.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Sales Manager (`PER-SALES-MGR`)

**Gruppo:** Sales Frontline & Management  
**Missione:** Guidare il team verso quota con priorità chiare, coaching tempestivo e pipeline verificabile.  

**Decisioni chiave:** priorità team; forecast category; deal coaching; escalation e approvazioni.  

**KPI principali:** Team quota attainment; Forecast accuracy; Stage conversion; Lead response SLA; Sales cycle; Rep productivity.  

**Integrazioni tipiche:** Email/Calendar; Telephony; Sales engagement; CPQ; Conversation intelligence; Data warehouse.  

**Scope dati/accesso:** Accesso ai record assegnati e al team; sconti, export e comunicazioni massive soggetti a policy.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Account Executive (`PER-SALES-AE`)

**Gruppo:** Sales Frontline & Management  
**Missione:** Portare opportunità qualificate alla chiusura costruendo valore, consenso del buying committee e un processo d'acquisto controllato.  

**Decisioni chiave:** priorità account; qualificazione; deal strategy; proposta e next step.  

**KPI principali:** Win rate; Bookings; Sales cycle; Average deal size; Next-step adherence; Forecast accuracy.  

**Integrazioni tipiche:** Email/Calendar; Telephony; Sales engagement; CPQ; E-sign; Product demo.  

**Scope dati/accesso:** Accesso ai record assegnati e al team; sconti, export e comunicazioni massive soggetti a policy.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## SDR / BDR (`PER-SALES-SDR`)

**Gruppo:** Sales Frontline & Management  
**Missione:** Creare conversazioni qualificate con gli account giusti, nel momento e sul canale appropriato, rispettando policy e ownership.  

**Decisioni chiave:** priorità prospect; messaggio e canale; qualificazione; handoff.  

**KPI principali:** Qualified meetings; Reply rate; Meeting held rate; Lead response time; Opportunity acceptance rate; Touches per meeting.  

**Integrazioni tipiche:** Sales engagement; Email; Telephony; LinkedIn/social; Calendar; Data enrichment.  

**Scope dati/accesso:** Accesso ai record assegnati e al team; sconti, export e comunicazioni massive soggetti a policy.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Customer Value Manager / CSM (`PER-CUST-CVM`)

**Gruppo:** Customer Success & Service  
**Missione:** Guidare ogni cliente verso outcome misurabili, adozione, rinnovo ed espansione con interventi proporzionati al rischio.  

**Decisioni chiave:** priorità portfolio; risk play; success plan; renewal ed expansion.  

**KPI principali:** Time to value; Health score movement; Renewal rate; Expansion ARR; Product adoption; Portfolio coverage.  

**Integrazioni tipiche:** Product analytics; Support desk; Billing; Learning platform; Survey/NPS; Calendar.  

**Scope dati/accesso:** Accesso ai clienti assegnati, casi e utilizzo necessario all'assistenza; azioni sensibili richiedono verifica.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Sales Enablement Specialist (`PER-SALES-ENABLE`)

**Gruppo:** Sales Frontline & Management  
**Missione:** Ridurre il tempo necessario per diventare efficaci e rendere replicabili i comportamenti che aumentano win rate e qualità.  

**Decisioni chiave:** curriculum; contenuti approvati; coaching priority; readiness.  

**KPI principali:** Ramp time; Certification rate; Content usage; Skill improvement; Win rate lift; Playbook adoption.  

**Integrazioni tipiche:** LMS; Conversation intelligence; Content repository; CRM; Product analytics; Knowledge base.  

**Scope dati/accesso:** Accesso ai record assegnati e al team; sconti, export e comunicazioni massive soggetti a policy.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Customer Service Agent (`PER-SVC-AGENT`)

**Gruppo:** Customer Success & Service  
**Missione:** Risolvere richieste rapidamente e correttamente con pieno contesto cliente, rispettando SLA, sicurezza e tono.  

**Decisioni chiave:** triage; risposta; risoluzione standard; escalation.  

**KPI principali:** First contact resolution; Average handle time; CSAT; SLA attainment; Reopen rate; Escalation rate.  

**Integrazioni tipiche:** Support desk; Contact center; Knowledge base; Order/Billing; Identity verification; Status page.  

**Scope dati/accesso:** Accesso ai clienti assegnati, casi e utilizzo necessario all'assistenza; azioni sensibili richiedono verifica.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Partner / Channel Manager (`PER-CHANNEL-MGR`)

**Gruppo:** Partner & Ecosystem  
**Missione:** Sviluppare un ecosistema produttivo e governato, aumentando pipeline e ricavi sourced o influenced dai partner.  

**Decisioni chiave:** tier e investimento; deal registration; co-sell priority; incentivi.  

**KPI principali:** Partner-sourced pipeline; Activated partners; Deal registration SLA; Partner win rate; MDF ROI; Partner retention.  

**Integrazioni tipiche:** Partner portal; PRM; CRM; Marketing automation; LMS; Finance.  

**Scope dati/accesso:** Accesso segregato per partner, territorio e deal registration; nessuna visibilità cross-partner non autorizzata.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Performance Marketing Specialist (`PER-MKT-PERF`)

**Gruppo:** Marketing & Growth  
**Missione:** Investire il budget media dove genera crescita incrementale e clienti di valore, con misurazione closed-loop.  

**Decisioni chiave:** budget e bid; audience; creative test; pause e riallocazioni.  

**KPI principali:** Incremental ROAS; CAC; Cost per opportunity; Qualified pipeline; Conversion rate; Budget pacing.  

**Integrazioni tipiche:** Ad platforms; Web analytics; Tag manager; CRM; Offline conversion API; Data warehouse.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Content Marketing Manager (`PER-MKT-CONTENT`)

**Gruppo:** Marketing & Growth  
**Missione:** Produrre e distribuire contenuti autorevoli e riusabili che rispondono ai bisogni del mercato e influenzano pipeline e adozione.  

**Decisioni chiave:** topic e formato; brief e fonti; approvazione; distribuzione e refresh.  

**KPI principali:** Content-influenced pipeline; Organic demand; Engagement quality; Time to publish; Content reuse; Freshness coverage.  

**Integrazioni tipiche:** CMS; DAM; SEO tools; CRM; Marketing automation; Knowledge base.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Campaign & Lifecycle Manager (`PER-MKT-CAMPAIGN`)

**Gruppo:** Marketing & Growth  
**Missione:** Portare campagne e journey dal brief al risultato con segmentazione corretta, orchestration affidabile e learning continuo.  

**Decisioni chiave:** audience e trigger; journey design; launch/pause; test e rollout.  

**KPI principali:** Campaign conversion; Incremental lift; Pipeline/revenue; Delivery success; Cycle time; Unsubscribe/pressure.  

**Integrazioni tipiche:** Marketing automation; Email/SMS; Ad platforms; CMS; CRM; Product events.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## CRO / Conversion Optimization Specialist (`PER-GROWTH-CRO`)

**Gruppo:** Marketing & Growth  
**Missione:** Aumentare la conversione sostenibile rimuovendo frizioni e validando causalmente le modifiche all'esperienza.  

**Decisioni chiave:** ipotesi; design esperimento; rollout; personalizzazione.  

**KPI principali:** Conversion lift; Experiment velocity; Revenue per visitor; Form completion; Guardrail metrics; Learning reuse.  

**Integrazioni tipiche:** Web analytics; Experimentation platform; Session replay; CMS; CRM; Product analytics.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## ABM Manager (`PER-MKT-ABM`)

**Gruppo:** Marketing & Growth  
**Missione:** Creare engagement coordinato e rilevante nei target account, collegando intent, buying committee, seller action e pipeline.  

**Decisioni chiave:** account tier; play e personalizzazione; seller alert; budget per account.  

**KPI principali:** Engaged target accounts; Account progression; ABM pipeline; Target account win rate; Buying committee coverage; Cost per engaged account.  

**Integrazioni tipiche:** Intent data; Ad platforms; Sales engagement; CRM; Content platform; Data enrichment.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Product Marketing Manager (`PER-MKT-PMM`)

**Gruppo:** Marketing & Growth  
**Missione:** Tradurre mercato, clienti e prodotto in positioning, messaggi, prove e lanci che aumentano adozione e win rate.  

**Decisioni chiave:** positioning; messaging; launch scope; competitive response.  

**KPI principali:** Launch adoption; Win rate; Message resonance; Sales readiness; Feature adoption; Proof asset usage.  

**Integrazioni tipiche:** Product analytics; CRM; Survey/research; Content repository; Conversation intelligence; Roadmap tool.  

**Scope dati/accesso:** Accesso a audience e performance con consenso e purpose limitation; PII minimizzata nell'analisi.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Data Engineering Manager (`PER-DATA-ENG`)

**Gruppo:** Data, AI & Engineering  
**Missione:** Fornire dati cliente affidabili, freschi, tracciabili e sostenibili per analytics, workflow e agenti.  

**Decisioni chiave:** architettura; data contract; SLA; priorità incidenti e investimenti.  

**KPI principali:** Data freshness SLA; Pipeline success rate; Data quality score; Cost per processed event; Mean time to recover; Schema compatibility.  

**Integrazioni tipiche:** Warehouse/Lakehouse; Event bus; dbt/Transformation; Source systems; Reverse ETL; Observability.  

**Scope dati/accesso:** Accesso tecnico per ambiente; dati produzione mascherati per default e privilegi elevati just-in-time.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Data Analytics / BI Expert (`PER-DATA-ANALYTICS`)

**Gruppo:** Data, AI & Engineering  
**Missione:** Trasformare dati certificati in decisioni comprensibili, ripetibili e tempestive per ogni funzione revenue.  

**Decisioni chiave:** metric definition; analysis method; certification; narrative and recommendation.  

**KPI principali:** Time to insight; Dashboard adoption; Metric reconciliation; Query performance; Alert precision; Decision follow-through.  

**Integrazioni tipiche:** Data warehouse; BI; Semantic layer; CRM; Product analytics; Experimentation.  

**Scope dati/accesso:** Accesso tecnico per ambiente; dati produzione mascherati per default e privilegi elevati just-in-time.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Data Scientist / ML Engineer (`PER-DATA-SCI`)

**Gruppo:** Data, AI & Engineering  
**Missione:** Costruire modelli che migliorano decisioni e azioni CRM, misurando utility reale, rischio e drift.  

**Decisioni chiave:** problem framing; model/feature choice; deployment gate; retraining e rollback.  

**KPI principali:** Decision utility; Model calibration; Lift/uplift; Drift; Inference latency; False action rate.  

**Integrazioni tipiche:** Feature store; Model registry; Warehouse; CRM workflows; Experimentation; Observability.  

**Scope dati/accesso:** Accesso tecnico per ambiente; dati produzione mascherati per default e privilegi elevati just-in-time.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## CRM/CDP Administrator (`PER-PLAT-ADMIN`)

**Gruppo:** Product & Platform Operations  
**Missione:** Mantenere Accordo configurato, sicuro, affidabile e facile da usare, senza introdurre bypass o debito operativo.  

**Decisioni chiave:** configurazione; accesso; release; troubleshooting e rollback.  

**KPI principali:** Change success rate; Admin request cycle time; Data quality; Automation failure rate; Adoption; Permission incidents.  

**Integrazioni tipiche:** IAM/SSO; Data sources; Email/Calendar; Marketing automation; Support; Observability.  

**Scope dati/accesso:** Accesso a configurazioni e telemetry; promozione in produzione solo tramite gate e audit.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Integration / API Developer (`PER-DEV-INTEGRATION`)

**Gruppo:** Data, AI & Engineering  
**Missione:** Collegare Accordo in modo sicuro e affidabile a sistemi, eventi e strumenti esterni, preservando contratti e consistenza.  

**Decisioni chiave:** contract e mapping; sync strategy; failure handling; versioning e rollout.  

**KPI principali:** Sync success rate; Data loss incidents; Integration latency; MTTR; API error rate; Backward compatibility.  

**Integrazioni tipiche:** External APIs; Event bus; Webhook providers; CI/CD; Secret manager; Observability.  

**Scope dati/accesso:** Accesso tecnico per ambiente; dati produzione mascherati per default e privilegi elevati just-in-time.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Agentic CRM Platform Engineer / AI Automation Architect (`PER-AI-AGENT-ENG`)

**Gruppo:** Data, AI & Engineering  
**Missione:** Costruire agenti CRM affidabili che osservano, decidono e agiscono entro policy verificabili, con evaluation e rollback.  

**Decisioni chiave:** agent contract; tool e autonomy boundary; model routing; deploy e rollback.  

**KPI principali:** Task success rate; Policy violation rate; Human override rate; Cost per successful job; Latency; Regression escape rate.  

**Integrazioni tipiche:** Model providers; MCP/tool servers; Workflow engine; Knowledge store; Evaluation platform; Observability.  

**Scope dati/accesso:** Accesso tecnico per ambiente; dati produzione mascherati per default e privilegi elevati just-in-time.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Data Governance, Privacy & Security Manager (`PER-GOV-DATA`)

**Gruppo:** Governance & Finance  
**Missione:** Garantire che dati, automazioni e agenti siano usati secondo finalità, permessi, sicurezza e accountability dimostrabili.  

**Decisioni chiave:** policy e lawful basis; accesso; eccezione; incident e AI approval.  

**KPI principali:** Policy violation rate; Access review completion; DSAR SLA; Audit findings; Incident MTTR; AI risk exceptions.  

**Integrazioni tipiche:** IAM/SSO; DLP; SIEM; Consent platform; Data catalog; Ticketing.  

**Scope dati/accesso:** Accesso a dati e log necessari a controllo e riconciliazione, con segregation of duties e tracciabilità.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Revenue Finance Analyst (`PER-FIN-REV`)

**Gruppo:** Governance & Finance  
**Missione:** Riconciliare piano, pipeline, bookings, billing e ricavi per rendere affidabili le decisioni economiche del motore revenue.  

**Decisioni chiave:** metric policy; forecast adjustment; budget variance; profitability e control.  

**KPI principali:** Forecast accuracy; Revenue reconciliation variance; Gross margin; CAC payback; Budget variance; Closing cycle time.  

**Integrazioni tipiche:** ERP; Billing; CRM; Data warehouse; Commission system; Planning tool.  

**Scope dati/accesso:** Accesso a dati e log necessari a controllo e riconciliazione, con segregation of duties e tracciabilità.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.

## Deal Desk / Commercial Operations Specialist (`PER-OPS-DEAL-DESK`)

**Gruppo:** Governance & Finance  
**Missione:** Portare le richieste commerciali dalla configurazione alla firma rapidamente, proteggendo margine, policy e obblighi.  

**Decisioni chiave:** completezza deal; pricing e sconto; approvazione; eccezione contrattuale.  

**KPI principali:** Quote turnaround time; Approval SLA; Discount leakage; Gross margin; Rework rate; Contract cycle time.  

**Integrazioni tipiche:** CPQ; CRM; Contract lifecycle management; E-sign; ERP/Tax; Security review.  

**Scope dati/accesso:** Accesso a dati e log necessari a controllo e riconciliazione, con segregation of duties e tracciabilità.  

**Distribuzione lifecycle:** ADOPT=4, RUN=8, OPTIMIZE=4, MAINTAIN=1, GOVERN=1, EVOLVE=2.



---

<!-- SOURCE: docs/02_capability_map.md -->

# 02 — Capability map

Le capability sono il ponte tra JTBD e implementazione. Gli ID devono comparire in epic, PR, test ed evidenze di coverage.

## Platform Foundation

| ID | Capability | Evidence minima |
|---|---|---|
| `PLT-001` | Tenant, workspace e business unit | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-002` | Modello entità e campi configurabile via manifest | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-003` | Relazioni e gerarchie configurabili | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-004` | Custom object e custom field | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-005` | Migrazioni e versioning dello schema | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-006` | Ruoli, team e permission model | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-007` | Field-level e record-level security | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-008` | Audit trail di record e configurazioni | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-009` | Ricerca, indicizzazione e viste | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-010` | Operazioni bulk e mass update | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-011` | Import, export e mapping | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-012` | Sandbox, ambienti e dati seed | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-013` | Feature flag e progressive rollout | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-014` | Localizzazione, valuta e fuso orario | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-015` | Esperienza mobile e offline | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-016` | Console amministrativa | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-017` | Archiviazione, retention e restore | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |
| `PLT-018` | Notifiche, subscription e digest | schema/manifest; service/API; admin UI; authorization test; migration/rollback test |

## Customer Data Platform

| ID | Capability | Evidence minima |
|---|---|---|
| `DAT-001` | Connettori a fonti dati | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-002` | Ingestion batch | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-003` | Ingestion streaming e real-time | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-004` | Reverse ETL e data activation | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-005` | Identity resolution | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-006` | Profile stitching e unified profile | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-007` | Gerarchie account, contact e household | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-008` | Golden record e master data management | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-009` | Data profiling e quality score | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-010` | Validazione, standardizzazione e enrichment | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-011` | Deduplica, merge e survivorship | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-012` | Lineage, catalogo e provenienza | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-013` | Customer timeline unificata | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-014` | Product usage e behavioral events | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-015` | Ordini, transazioni, billing e subscription | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-016` | Intent, firmographic e third-party enrichment | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-017` | Data contract e schema registry | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-018` | Freshness, SLA e volume monitoring | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-019` | Consent, preference e lawful basis data | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-020` | Computed trait, feature e score | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-021` | Destination e audience activation | connector or ingestion code; data model; lineage/freshness; quality test; activation test |
| `DAT-022` | Buying committee e relationship graph | connector or ingestion code; data model; lineage/freshness; quality test; activation test |

## Sales CRM

| ID | Capability | Evidence minima |
|---|---|---|
| `SAL-001` | Lead capture e conversion | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-002` | Lead e account routing | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-003` | Qualification framework ed exit criteria | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-004` | Scoring e prioritizzazione | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-005` | Account e contact management | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-006` | Opportunity, stage e pipeline management | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-007` | Sync email, calendario e attività | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-008` | Sequence, cadence e task automation | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-009` | Meeting e conversation intelligence | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-010` | Next best action commerciale | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-011` | Forecasting e commit | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-012` | Territori, quote e capacità | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-013` | Deal inspection e risk signal | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-014` | Mutual action plan e stakeholder plan | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-015` | Quote, product configuration e CPQ | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-016` | Approval e deal desk | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-017` | Contratti, redline ed e-sign | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-018` | Sales playbook e guided selling | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-019` | Relationship intelligence | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-020` | Competitive intelligence e win-loss | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-021` | Partner, channel e deal registration | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-022` | Handoff a onboarding e Customer | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-023` | Mobile sales workspace | domain model; service/workflow; role UI; permission test; end-to-end scenario |
| `SAL-024` | Attainment, commission e incentive visibility | domain model; service/workflow; role UI; permission test; end-to-end scenario |

## Marketing & Growth

| ID | Capability | Evidence minima |
|---|---|---|
| `MKT-001` | Audience e segment builder | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-002` | Segmenti real-time | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-003` | Journey e lifecycle orchestration | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-004` | Campaign planning e calendario | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-005` | Activation multicanale | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-006` | Email, SMS, push e messaging | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-007` | Paid media audience sync | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-008` | Web e in-app personalization | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-009` | Content e asset management | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-010` | Template e brand governance | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-011` | Dynamic content e personalization | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-012` | Form, landing page e lead capture | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-013` | A/B test ed experimentation | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-014` | Deliverability, pressure e frequency cap | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-015` | Attribution e revenue influence | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-016` | Budget, pacing e spend control | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-017` | SEO e content intelligence | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-018` | ABM e intent orchestration | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-019` | Lead nurture e lifecycle | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-020` | Suppression, exclusion e eligibility | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-021` | Campaign QA e approval | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-022` | Conversion rate optimization | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-023` | UTM, taxonomy e tracking governance | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-024` | Event, webinar e social activation | audience/journey model; orchestration; channel integration; QA/consent test; measurement |
| `MKT-025` | Next best content e recommendation | audience/journey model; orchestration; channel integration; QA/consent test; measurement |

## Customer Success & Service

| ID | Capability | Evidence minima |
|---|---|---|
| `CSV-001` | Onboarding plan e milestone | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-002` | Customer health score | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-003` | Adoption e usage monitoring | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-004` | Success plan e outcome tracking | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-005` | QBR, EBR e task management | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-006` | Churn, contraction e risk signal | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-007` | Renewal management e forecast | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-008` | Expansion e upsell signal | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-009` | Case e ticket management | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-010` | Omnichannel service | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-011` | SLA, queue e skill-based routing | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-012` | Knowledge base e retrieval | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-013` | Agent assist | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-014` | Voice of customer | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-015` | NPS, CSAT e CES | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-016` | Escalation, swarming e incident | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-017` | Customer portal e self-service | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-018` | Entitlement, contract e service eligibility | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-019` | Customer communication e notification | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-020` | Service analytics e workforce | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-021` | Product feedback loop | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-022` | Value realization e ROI | customer model; workflow/queue; role UI; SLA test; outcome telemetry |
| `CSV-023` | Advocacy, reference e community | customer model; workflow/queue; role UI; SLA test; outcome telemetry |

## Analytics & AI

| ID | Capability | Evidence minima |
|---|---|---|
| `AIA-001` | Semantic metric layer | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-002` | Dashboard ed exploration | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-003` | Funnel, cohort e journey analytics | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-004` | Forecasting e predictive analytics | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-005` | Causal inference ed experimentation | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-006` | Attribution e marketing mix modeling | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-007` | Natural language query | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-008` | Anomaly detection | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-009` | Propensity, health e risk scoring | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-010` | Recommendation e next best action | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-011` | Generazione di contenuti e artefatti | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-012` | Riassunto di conversazioni e record | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-013` | Knowledge retrieval e RAG | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-014` | Agent runtime e orchestration | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-015` | Tool e action registry | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-016` | Memoria, contesto e state agentico | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-017` | Planning e task decomposition | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-018` | Collaborazione multi-agent | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-019` | Human approval e exception inbox | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-020` | Policy, guardrail e autonomy boundary | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-021` | Evaluation harness e regression test | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-022` | Prompt, model e version management | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-023` | Cost, latency e token control | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-024` | Explainability, evidenze e confidence | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-025` | Feedback e learning loop | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-026` | Simulation e digital twin | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-027` | Autonomous optimization | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |
| `AIA-028` | Agent template e capability marketplace | metric/model/agent implementation; evaluation set; trace/evidence; guardrail test; cost/latency telemetry |

## Workflow & Automation

| ID | Capability | Evidence minima |
|---|---|---|
| `AUT-001` | Event e trigger rule | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-002` | Visual workflow builder | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-003` | Azione multi-step | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-004` | Branch, condition e decision table | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-005` | Job schedulato e ricorrente | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-006` | Transazione, idempotenza e exactly-once effect | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-007` | Retry, timeout e dead-letter | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-008` | Transactional event outbox | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-009` | Approval workflow | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-010` | Task, SLA e due date | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-011` | Webhook, API e external action | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-012` | Business rule e managed field | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-013` | Change set, deployment e promotion | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-014` | Rollback e compensating action | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-015` | Run history, replay e debugging | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-016` | Workflow template e blueprint | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-017` | Process mining e bottleneck discovery | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |
| `AUT-018` | Agent-triggered workflow | trigger/action code; transaction/idempotency; retry/rollback; run history; integration test |

## Governance & Security

| ID | Capability | Evidence minima |
|---|---|---|
| `GOV-001` | SSO e MFA | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-002` | RBAC e ABAC | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-003` | Consent e lawful basis | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-004` | DSAR, export e delete | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-005` | Encryption, residency e key management | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-006` | Audit log e immutable decision trail | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-007` | Segregation of duties | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-008` | DLP e PII detection | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-009` | Model e AI governance | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-010` | Policy-as-code | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-011` | Retention e legal hold | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-012` | Vendor e connector governance | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-013` | Risk e compliance reporting | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-014` | Incident response | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-015` | Access review e recertification | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-016` | Data minimization e purpose limitation | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-017` | Bias e fairness | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |
| `GOV-018` | Explainability e accountability | policy/config; enforcement point; audit evidence; negative authorization test; incident/runbook |

## Developer Platform

| ID | Capability | Evidence minima |
|---|---|---|
| `DEV-001` | Public API | public contract; implementation; compatibility test; observability; documentation |
| `DEV-002` | Webhook e event subscription | public contract; implementation; compatibility test; observability; documentation |
| `DEV-003` | SDK e CLI | public contract; implementation; compatibility test; observability; documentation |
| `DEV-004` | MCP e tool server | public contract; implementation; compatibility test; observability; documentation |
| `DEV-005` | App e plugin framework | public contract; implementation; compatibility test; observability; documentation |
| `DEV-006` | Custom action e serverless function | public contract; implementation; compatibility test; observability; documentation |
| `DEV-007` | Connector SDK | public contract; implementation; compatibility test; observability; documentation |
| `DEV-008` | Fixture, synthetic data e test environment | public contract; implementation; compatibility test; observability; documentation |
| `DEV-009` | CI/CD e quality gate | public contract; implementation; compatibility test; observability; documentation |
| `DEV-010` | Log, metric e distributed trace | public contract; implementation; compatibility test; observability; documentation |
| `DEV-011` | Rate limit, quota e backpressure | public contract; implementation; compatibility test; observability; documentation |
| `DEV-012` | Secret e credential management | public contract; implementation; compatibility test; observability; documentation |
| `DEV-013` | Environment promotion | public contract; implementation; compatibility test; observability; documentation |
| `DEV-014` | Backward compatibility e deprecation | public contract; implementation; compatibility test; observability; documentation |
| `DEV-015` | Documentazione e schema discovery | public contract; implementation; compatibility test; observability; documentation |
| `DEV-016` | Event bus e message contract | public contract; implementation; compatibility test; observability; documentation |
| `DEV-017` | Warehouse, lakehouse e dbt integration | public contract; implementation; compatibility test; observability; documentation |
| `DEV-018` | Versioned migration | public contract; implementation; compatibility test; observability; documentation |
| `DEV-019` | Performance e scalability | public contract; implementation; compatibility test; observability; documentation |
| `DEV-020` | Backup e disaster recovery | public contract; implementation; compatibility test; observability; documentation |
| `DEV-021` | Reliability, SLO e capacity | public contract; implementation; compatibility test; observability; documentation |
| `DEV-022` | Agent development kit | public contract; implementation; compatibility test; observability; documentation |

## Collaboration & Enablement

| ID | Capability | Evidence minima |
|---|---|---|
| `COL-001` | Unified inbox e work queue | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-002` | Comment, mention e collaboration | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-003` | Note e conversation summary | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-004` | Playbook e coaching | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-005` | Knowledge e content recommendation | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-006` | Guided onboarding e in-product adoption | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-007` | Workspace e vista per ruolo | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-008` | Alert, notification e digest | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-009` | Goal, target e OKR tracking | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-010` | Change communication | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-011` | Training e certification | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-012` | Feedback e request intake | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-013` | Meeting, review e business pack | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-014` | Cross-functional handoff | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |
| `COL-015` | Decision log | role workflow; UI/inbox; notification; adoption telemetry; user acceptance test |

## Finance & Commercial

| ID | Capability | Evidence minima |
|---|---|---|
| `FIN-001` | ARR, MRR, TCV e bookings | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-002` | Pricing, packaging e product catalog | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-003` | Sconto, margine e approval | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-004` | Billing, invoice e payment | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-005` | Revenue forecast e recognition handoff | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-006` | Renewal, churn e contraction economics | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-007` | Commission e incentive | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-008` | CAC, LTV, payback e unit economics | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-009` | Budget, plan e scenario | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-010` | Deal e customer profitability | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-011` | Contract obligation e entitlement | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |
| `FIN-012` | Partner economics e MDF | calculation policy; source reconciliation; approval/control; audit trail; finance acceptance test |



---

<!-- SOURCE: docs/03_jtbd_catalog.md -->

# 03 — Catalogo JTBD e use case

Catalogo sintetico di 600 record. Il dettaglio completo è in `data/jtbd.jsonl`; questa vista è pensata per lettura e review.

## Chief Revenue Officer (`PER-EXEC-CRO`)

**Missione:** Massimizzare crescita efficiente e prevedibile coordinando marketing, sales, customer e finance su un unico sistema di decisione.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CRO-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire il modello revenue unificato, così da ottenere un risultato ripetibile per «definire il modello revenue unificato» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, PLT-002 | ARR bookings, Net Revenue Retention, Forecast accuracy | P1 / H1 |
| `ACC-JTBD-CRO-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio allineare lifecycle, ownership e SLA, così da ottenere un risultato ripetibile per «allineare lifecycle, ownership e sla» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, PLT-002 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare target, piano e assunzioni, così da ottenere un risultato ripetibile per «impostare target, piano e assunzioni» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, PLT-002 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire diritti decisionali ed escalation, così da ottenere un risultato ripetibile per «definire diritti decisionali ed escalation» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, PLT-002 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare il funnel end-to-end, così da ottenere un risultato ripetibile per «monitorare il funnel end-to-end» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-002 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre forecast di bookings, ARR e ricavi, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-024 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-CRO-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio ispezionare deal strategici e rischi, così da ottenere un risultato ripetibile per «ispezionare deal strategici e rischi» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-007 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare revenue play cross-funzionali, così da ottenere un risultato ripetibile per «coordinare revenue play cross-funzionali» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AUT-001 | ARR bookings, Net Revenue Retention, Forecast accuracy | P1 / H1 |
| `ACC-JTBD-CRO-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire copertura e velocità della pipeline, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | EXECUTE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AUT-001 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-CRO-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare rinnovi, churn e contrazione, così da intervenire prima che il rischio si materializzi e rendere prevedibile la retention. | GOVERN / L2 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-020 | Gross retention, Renewal forecast accuracy, At-risk ARR covered | P1 / H1 |
| `ACC-JTBD-CRO-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio identificare opportunità di expansion, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-007 | Expansion ARR, Expansion conversion, Net revenue retention | P2 / H2 |
| `ACC-JTBD-CRO-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio riconciliare piani Sales, Marketing e Customer, così da ottenere un risultato ripetibile per «riconciliare piani sales, marketing e customer» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-007 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-CRO-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio riallocare budget e capacità, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | DECIDE / L2 | HIGH | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-024 | Budget variance, Incremental return, Pacing accuracy | P1 / H1 |
| `ACC-JTBD-CRO-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare ICP, segmenti e channel mix, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | OPTIMIZE / L3 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-005 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CRO-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare pricing, sconti e margine, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | OPTIMIZE / L3 | HIGH | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-005 | Gross margin, Approval turnaround, Discount leakage | P1 / H1 |
| `ACC-JTBD-CRO-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare CAC, LTV e payback, così da ottenere un risultato ripetibile per «migliorare cac, ltv e payback» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-005 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-CRO-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio certificare affidabilità di metriche e dati, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | MAINTAIN / L3 | LOW | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, DEV-010 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-CRO-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio riesaminare decisioni agentiche ed eccezioni, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | GOVERN / L2 | HIGH | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-020 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-CRO-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio simulare scenari GTM con un revenue digital twin, così da ottenere un risultato ripetibile per «simulare scenari gtm con un revenue digital twin» con dati affidabili, responsabilità chiare e impatto misurabile. | EVOLVE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-021 | ARR bookings, Net Revenue Retention, Forecast accuracy | P3 / H3 |
| `ACC-JTBD-CRO-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio prioritizzare roadmap e differenziazione di Accordo, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | FIN-001, FIN-005, AIA-001, AIA-004, COL-009, AIA-021 | ARR bookings, Net Revenue Retention, Forecast accuracy | P2 / H2 |

## Direttore Marketing / CMO (`PER-EXEC-MKT-DIR`)

**Missione:** Generare domanda e crescita misurabili, orchestrando audience, canali, contenuti e lifecycle fino al risultato economico.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-MKT-DIR-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire ICP, audience e buying committee, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-MKT-DIR-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare target di demand, pipeline e budget, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | CONFIGURE / L3 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, PLT-002 | Pipeline coverage, Stage conversion, Pipeline velocity | P0 / H1 |
| `ACC-JTBD-MKT-DIR-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare operating model e tassonomia campagne, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | CONFIGURE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, PLT-002 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-DIR-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire governance di brand, consenso e pressione, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | CONFIGURE / L3 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, PLT-002 | Marketing-sourced pipeline, CAC, Cost per opportunity | P0 / H1 |
| `ACC-JTBD-MKT-DIR-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire portfolio e calendario campagne, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-DIR-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare funnel marketing-to-revenue, così da ottenere un risultato ripetibile per «monitorare funnel marketing-to-revenue» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-008 | Marketing-sourced pipeline, CAC, Cost per opportunity | P1 / H1 |
| `ACC-JTBD-MKT-DIR-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare channel mix e allocazione budget, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | EXECUTE / L2 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AUT-001 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-MKT-DIR-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio orchestrare lifecycle e customer journeys, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-DIR-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio allineare handoff e feedback con Sales, così da ottenere un risultato ripetibile per «allineare handoff e feedback con sales» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AUT-001 | Marketing-sourced pipeline, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-MKT-DIR-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare strategia e produzione contenuti, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | GOVERN / L2 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-020 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-MKT-DIR-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare programmi ABM e intent, così da ottenere un risultato ripetibile per «governare programmi abm e intent» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-020 | Marketing-sourced pipeline, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-MKT-DIR-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prevedere contributo marketing a pipeline e ricavi, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-MKT-DIR-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare CAC e costo per opportunità, così da ottenere un risultato ripetibile per «ottimizzare cac e costo per opportunità» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-005 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-MKT-DIR-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio valutare attribuzione e incrementality, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | INVESTIGATE / L2 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-007 | Marketing-sourced pipeline, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-MKT-DIR-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio prioritizzare esperimenti di crescita, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | DECIDE / L3 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-004 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-MKT-DIR-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare produttività del team con agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | OPTIMIZE / L3 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-005 | Task success rate, Human override rate, Policy violation rate | P1 / H1 |
| `ACC-JTBD-MKT-DIR-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere qualità di audience e dati di contatto, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | MAINTAIN / L3 | LOW | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, DEV-010 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-MKT-DIR-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio controllare deliverability, brand e compliance, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | GOVERN / L2 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-020 | Inbox placement, Bounce rate, Complaint/unsubscribe rate | P0 / H1 |
| `ACC-JTBD-MKT-DIR-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio razionalizzare stack, integrazioni e costi martech, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EVOLVE / L3 | MEDIUM | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-021 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P3 / H3 |
| `ACC-JTBD-MKT-DIR-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere roadmap marketing agentica e benchmark, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-003, MKT-004, MKT-015, MKT-016, AIA-002, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Direttore Vendite / VP Sales (`PER-EXEC-SALES-DIR`)

**Missione:** Rendere il motore commerciale prevedibile, produttivo e scalabile, con pipeline di qualità e coaching basato su evidenze.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-SALES-DIR-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire coverage model, segmenti e motion di vendita, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio standardizzare stage, exit criteria e qualificazione, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, PLT-002 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-SALES-DIR-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare territori, quote e capacità, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, PLT-002 | Quote turnaround, Contract cycle time, Rework rate | P2 / H2 |
| `ACC-JTBD-SALES-DIR-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire governance di processo e approvazioni, così da ottenere un risultato ripetibile per «definire governance di processo e approvazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, PLT-002 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare pipeline e conversioni per team, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | MONITOR / L2 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-008 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-SALES-DIR-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre forecast e commit di vendita, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-SALES-DIR-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare routing lead e SLA di presa in carico, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | GOVERN / L2 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-020 | Routing accuracy, Median response time, SLA attainment | P1 / H1 |
| `ACC-JTBD-SALES-DIR-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio ispezionare deal strategici e mutual action plan, così da ottenere un risultato ripetibile per «ispezionare deal strategici e mutual action plan» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-007 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio approvare pricing, sconti e condizioni, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | GOVERN / L2 | HIGH | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-020 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-SALES-DIR-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare produttività e attività commerciali, così da ottenere un risultato ripetibile per «monitorare produttività e attività commerciali» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-008 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare expansion e rinnovi con Customer, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AUT-001 | Expansion ARR, Expansion conversion, Net revenue retention | P2 / H2 |
| `ACC-JTBD-SALES-DIR-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare pipeline e co-selling dei partner, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | GOVERN / L2 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-020 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-SALES-DIR-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio analizzare win/loss e concorrenti, così da ottenere un risultato ripetibile per «analizzare win/loss e concorrenti» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-007 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare capacità, hiring e copertura, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-005 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare coaching e qualità delle conversazioni, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-005 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-SALES-DIR-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre leakage e tempi del sales cycle, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-005 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere qualità e ownership dei dati CRM, così da ottenere un risultato ripetibile per «mantenere qualità e ownership dei dati crm» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, DEV-010 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |
| `ACC-JTBD-SALES-DIR-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare uso sicuro degli agenti di vendita, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | GOVERN / L2 | HIGH | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-020 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-SALES-DIR-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio progettare nuovi play e automazioni commerciali, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EVOLVE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-021 | Workflow success rate, Cycle time reduction, Manual touches avoided | P3 / H3 |
| `ACC-JTBD-SALES-DIR-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere roadmap sales di Accordo, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | SAL-006, SAL-011, SAL-012, SAL-013, AIA-002, AIA-021 | Bookings, Quota attainment, Forecast accuracy | P2 / H2 |

## Direttore Customer Operations (`PER-EXEC-CUST-OPS`)

**Missione:** Offrire un servizio coerente, proattivo ed efficiente lungo l'intero customer journey, riducendo attriti e costo di gestione.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CUST-OPS-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare operating model di Customer Operations, così da ottenere un risultato ripetibile per «disegnare operating model di customer operations» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, PLT-002 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio mappare journey, canali e momenti critici, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, PLT-002 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-CUST-OPS-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire tassonomia casi, SLA e priorità, così da ottenere un risultato ripetibile per «definire tassonomia casi, sla e priorità» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, PLT-002 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare routing, escalation e responsabilità, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, PLT-002 | Routing accuracy, Median response time, SLA attainment | P1 / H1 |
| `ACC-JTBD-CUST-OPS-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare code, volumi e capacità, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | MONITOR / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-002 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire servizio omnicanale con customer 360, così da ottenere un risultato ripetibile per «gestire servizio omnicanale con customer 360» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AUT-001 | First contact resolution, SLA attainment, CSAT | P1 / H2 |
| `ACC-JTBD-CUST-OPS-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare escalation e swarming, così da ottenere un risultato ripetibile per «governare escalation e swarming» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-020 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio mantenere knowledge base e risposte approvate, così da ottenere un risultato ripetibile per «mantenere knowledge base e risposte approvate» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AUT-001 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio rilevare problemi proattivamente, così da ottenere un risultato ripetibile per «rilevare problemi proattivamente» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-002 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare handoff tra Sales, Onboarding e Service, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AUT-001 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-CUST-OPS-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio misurare CSAT, NPS, CES e sentiment, così da ottenere un risultato ripetibile per «misurare csat, nps, ces e sentiment» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-002 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire incidenti e comunicazioni ai clienti, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AUT-001 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-CUST-OPS-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre cost-to-serve e tempi di risoluzione, così da risolvere correttamente al primo contatto o escalare con contesto completo e SLA preservato. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-005 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare self-service e deflection, così da risolvere correttamente al primo contatto o escalare con contesto completo e SLA preservato. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-005 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità e coerenza delle risposte, così da ottenere un risultato ripetibile per «migliorare qualità e coerenza delle risposte» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-005 | First contact resolution, SLA attainment, CSAT | P2 / H2 |
| `ACC-JTBD-CUST-OPS-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio identificare root cause e prevenire recidive, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | INVESTIGATE / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-007 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-CUST-OPS-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere SLA, audit e continuità operativa, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | MAINTAIN / L3 | HIGH | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, DEV-010 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-CUST-OPS-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare privacy, autenticazione e azioni sensibili, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-CUST-OPS-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio introdurre agent assist e automazioni controllate, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-CUST-OPS-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere piattaforma e processi Customer, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-016, CSV-020, AIA-021 | First contact resolution, SLA attainment, CSAT | P3 / H3 |

## Revenue Operations Director / Manager (`PER-OPS-REVOPS`)

**Missione:** Progettare e governare dati, processi, metriche e automazioni che collegano marketing, sales, customer e finance.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-REVOPS-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire lifecycle e source of truth revenue, così da ottenere un risultato ripetibile per «definire lifecycle e source of truth revenue» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, PLT-002 | Funnel conversion, Routing SLA, Forecast reconciliation | P1 / H1 |
| `ACC-JTBD-REVOPS-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare modello dati e ownership, così da ottenere un risultato ripetibile per «disegnare modello dati e ownership» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, PLT-002 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |
| `ACC-JTBD-REVOPS-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio standardizzare processi e handoff, così da ottenere un risultato ripetibile per «standardizzare processi e handoff» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, PLT-002 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |
| `ACC-JTBD-REVOPS-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare KPI, semantic layer e governance, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CONFIGURE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, PLT-002 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-REVOPS-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire routing, assegnazione e SLA, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | EXECUTE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AUT-001 | Routing accuracy, Median response time, SLA attainment | P1 / H1 |
| `ACC-JTBD-REVOPS-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare scoring e qualificazione, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | GOVERN / L2 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-020 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-REVOPS-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare pipeline, funnel e velocità, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | MONITOR / L2 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-002 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-REVOPS-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre forecast operativo riconciliato, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-REVOPS-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire territori, quote e capacity model, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | EXECUTE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AUT-001 | Quote turnaround, Contract cycle time, Rework rate | P2 / H2 |
| `ACC-JTBD-REVOPS-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare automazioni e workflow cross-funzionali, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P1 / H2 |
| `ACC-JTBD-REVOPS-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio riconciliare attribuzione, bookings e ricavi, così da ottenere un risultato ripetibile per «riconciliare attribuzione, bookings e ricavi» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-007 | Funnel conversion, Routing SLA, Forecast reconciliation | P1 / H1 |
| `ACC-JTBD-REVOPS-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio supportare planning e business review, così da ottenere un risultato ripetibile per «supportare planning e business review» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AUT-001 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |
| `ACC-JTBD-REVOPS-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare conversioni e process adherence, così da ottenere un risultato ripetibile per «migliorare conversioni e process adherence» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-005 | Funnel conversion, Routing SLA, Forecast reconciliation | P1 / H1 |
| `ACC-JTBD-REVOPS-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare capacità e carichi di lavoro, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | OPTIMIZE / L3 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-005 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |
| `ACC-JTBD-REVOPS-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre lavoro manuale e tempi di ciclo, così da ottenere un risultato ripetibile per «ridurre lavoro manuale e tempi di ciclo» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-005 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |
| `ACC-JTBD-REVOPS-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio individuare gap di processo e automazione, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P2 / H2 |
| `ACC-JTBD-REVOPS-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere qualità, deduplica e data contract, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-REVOPS-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare permessi, change e segregation of duties, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-020 | Funnel conversion, Routing SLA, Forecast reconciliation | P0 / H1 |
| `ACC-JTBD-REVOPS-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio orchestrare release e integrazioni revenue, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EVOLVE / L3 | HIGH | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-021 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P3 / H3 |
| `ACC-JTBD-REVOPS-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio prioritizzare roadmap Accordo per impatto, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | AIA-001, AUT-002, DAT-009, SAL-002, COL-014, AIA-021 | Funnel conversion, Routing SLA, Forecast reconciliation | P2 / H2 |

## Direttore Customer Success (`PER-EXEC-CS-DIR`)

**Missione:** Massimizzare adozione, valore, retention ed expansion con un modello Customer Success scalabile e predittivo.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CS-DIR-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio segmentare clienti e definire coverage model, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CS-DIR-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare onboarding e time-to-value, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, PLT-002 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-CS-DIR-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire health score e segnali di rischio, così da distinguere segnali reali da rumore e attivare il play proporzionato. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, PLT-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CS-DIR-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio standardizzare success plan, QBR e playbook, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, PLT-002 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare adozione e portfolio health, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MONITOR / L2 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CS-DIR-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare onboarding e milestone, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | GOVERN / L2 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-020 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-CS-DIR-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prevedere rinnovi, churn e contrazione, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-CS-DIR-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare play di rischio ed escalation, così da ottenere un risultato ripetibile per «coordinare play di rischio ed escalation» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AUT-001 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio identificare expansion e advocacy, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | INVESTIGATE / L2 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-007 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-CS-DIR-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio misurare value realization e ROI cliente, così da ottenere un risultato ripetibile per «misurare value realization e roi cliente» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-002 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare QBR/EBR e stakeholder map, così da ottenere un risultato ripetibile per «governare qbr/ebr e stakeholder map» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-020 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio raccogliere feedback e chiudere il loop prodotto, così da ottenere un risultato ripetibile per «raccogliere feedback e chiudere il loop prodotto» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AUT-001 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare capacità e assegnazione CSM, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | OPTIMIZE / L3 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-005 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare retention e net revenue retention, così da ottenere un risultato ripetibile per «migliorare retention e net revenue retention» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-005 | Gross retention, Net revenue retention, Time to value | P1 / H1 |
| `ACC-JTBD-CS-DIR-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare adozione delle feature, così da distinguere segnali reali da rumore e attivare il play proporzionato. | OPTIMIZE / L3 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-005 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CS-DIR-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare qualità e consistenza dei playbook, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | OPTIMIZE / L3 | LOW | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-005 | Gross retention, Net revenue retention, Time to value | P2 / H2 |
| `ACC-JTBD-CS-DIR-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere qualità di health score e dati utilizzo, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MAINTAIN / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, DEV-010 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CS-DIR-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare comunicazioni, consenso e agenti Customer, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-020 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-CS-DIR-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio progettare nuovi play autonomi di retention, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-021 | Task success rate, Human override rate, Policy violation rate | P3 / H3 |
| `ACC-JTBD-CS-DIR-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere roadmap Customer Success di Accordo, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | CSV-002, CSV-003, CSV-006, CSV-007, CSV-022, AIA-021 | Gross retention, Net revenue retention, Time to value | P2 / H2 |

## CRM/CDP Product Owner (`PER-PROD-CRM-PO`)

**Missione:** Trasformare bisogni e JTBD in una piattaforma coerente, adottata, verificabile e progressivamente più agentica.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CRM-PO-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire vision, outcome e principi di Accordo, così da ottenere un risultato ripetibile per «definire vision, outcome e principi di accordo» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-012 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio raccogliere bisogni e mappare stakeholder, così da ottenere un risultato ripetibile per «raccogliere bisogni e mappare stakeholder» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-012 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio costruire capability map e glossario dominio, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | CONFIGURE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-012 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire criteri di successo e telemetry plan, così da ottenere un risultato ripetibile per «definire criteri di successo e telemetry plan» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-012 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire backlog JTBD e dipendenze, così da ottenere un risultato ripetibile per «gestire backlog jtbd e dipendenze» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio tradurre use case in requisiti testabili, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | EXECUTE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-CRM-PO-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio decidere configurazione versus sviluppo custom, così da ottenere un risultato ripetibile per «decidere configurazione versus sviluppo custom» con dati affidabili, responsabilità chiare e impatto misurabile. | DECIDE / L3 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-004 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio disegnare data model, workflow e agent UX, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EXECUTE / L2 | HIGH | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-CRM-PO-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio pianificare release, rollout e change management, così da ottenere un risultato ripetibile per «pianificare release, rollout e change management» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L2 | HIGH | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Outcome adoption, Time to value, Release predictability | P0 / H1 |
| `ACC-JTBD-CRM-PO-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare discovery, delivery e acceptance, così da ottenere un risultato ripetibile per «coordinare discovery, delivery e acceptance» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare adozione e outcome di prodotto, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MONITOR / L2 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CRM-PO-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire feedback, incidenti e richieste, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | EXECUTE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AUT-001 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-CRM-PO-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio prioritizzare con valore, rischio ed effort, così da ottenere un risultato ripetibile per «prioritizzare con valore, rischio ed effort» con dati affidabili, responsabilità chiare e impatto misurabile. | DECIDE / L3 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-004 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre debito tecnico e complessità, così da ottenere un risultato ripetibile per «ridurre debito tecnico e complessità» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-005 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare time-to-value della configurazione, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | OPTIMIZE / L3 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-005 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-CRM-PO-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare discoverability e usabilità, così da ottenere un risultato ripetibile per «migliorare discoverability e usabilità» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-005 | Outcome adoption, Time to value, Release predictability | P2 / H2 |
| `ACC-JTBD-CRM-PO-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere coerenza di schema, API e documentazione, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | MAINTAIN / L3 | HIGH | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, DEV-010 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P0 / H1 |
| `ACC-JTBD-CRM-PO-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare privacy, sicurezza e AI by design, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-CRM-PO-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio valutare benchmark e gap competitivi, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-013 | Outcome adoption, Time to value, Release predictability | P3 / H3 |
| `ACC-JTBD-CRM-PO-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere piattaforma tramite agenti e capability pack, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | PLT-002, AUT-013, COL-012, AIA-021, DEV-009, PLT-013 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Marketing Operations & CRM Manager (`PER-OPS-MKT-OPS`)

**Missione:** Rendere eseguibili, misurabili e affidabili campagne, lifecycle e handoff attraverso dati e automazioni governate.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-MKT-OPS-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare lifecycle, tassonomie e naming convention, così da ottenere un risultato ripetibile per «configurare lifecycle, tassonomie e naming convention» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, PLT-002 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare modello dati marketing e sincronizzazioni, così da ottenere un risultato ripetibile per «impostare modello dati marketing e sincronizzazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, PLT-002 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire consenso, suppression e preference center, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | CONFIGURE / L3 | HIGH | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, PLT-002 | Campaign cycle time, Lead routing SLA, Data completeness | P0 / H1 |
| `ACC-JTBD-MKT-OPS-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare template, ruoli e processo di campaign intake, così da ottenere un risultato ripetibile per «preparare template, ruoli e processo di campaign intake» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, PLT-002 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire audience e segmenti, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-MKT-OPS-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire scoring, routing e lead lifecycle, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Routing accuracy, Median response time, SLA attainment | P1 / H1 |
| `ACC-JTBD-MKT-OPS-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare journey e automazioni, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-OPS-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire QA e approvazione campagne, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-OPS-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire form, landing page e tracking, così da ottenere un risultato ripetibile per «gestire form, landing page e tracking» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare deliverability e frequenza, così da ottenere un risultato ripetibile per «monitorare deliverability e frequenza» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-002 | Inbox placement, Bounce rate, Complaint/unsubscribe rate | P2 / H2 |
| `ACC-JTBD-MKT-OPS-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire UTM, attribution e campaign metadata, così da ottenere un risultato ripetibile per «gestire utm, attribution e campaign metadata» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio risolvere errori di sync e workflow, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EXECUTE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AUT-001 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P1 / H2 |
| `ACC-JTBD-MKT-OPS-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità, deduplica e match rate, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | OPTIMIZE / L3 | LOW | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-005 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-MKT-OPS-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare tempi di produzione campagne, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | OPTIMIZE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-005 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-MKT-OPS-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre leakage tra sistemi e stage, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | OPTIMIZE / L3 | LOW | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-005 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare riuso di template e componenti, così da ottenere un risultato ripetibile per «aumentare riuso di template e componenti» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-005 | Campaign cycle time, Lead routing SLA, Data completeness | P2 / H2 |
| `ACC-JTBD-MKT-OPS-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere integrazioni, scheduler e data freshness, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-MKT-OPS-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare accessi, release e audit delle modifiche, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-MKT-OPS-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio automatizzare operations con agenti controllati, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-MKT-OPS-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere standard e architettura martech, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | MKT-003, MKT-021, MKT-023, DAT-019, AUT-002, AIA-021 | Campaign cycle time, Lead routing SLA, Data completeness | P3 / H3 |

## Sales Manager (`PER-SALES-MGR`)

**Missione:** Guidare il team verso quota con priorità chiare, coaching tempestivo e pipeline verificabile.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-SALES-MGR-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare vista team, obiettivi e territori, così da ottenere un risultato ripetibile per «configurare vista team, obiettivi e territori» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, PLT-002 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio allineare criteri di qualificazione e stage, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, PLT-002 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-SALES-MGR-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare cadenza di forecast e pipeline review, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, PLT-002 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-SALES-MGR-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire playbook, SLA e coaching loop, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | CONFIGURE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, PLT-002 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-SALES-MGR-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prioritizzare attività giornaliere del team, così da ottenere un risultato ripetibile per «prioritizzare attività giornaliere del team» con dati affidabili, responsabilità chiare e impatto misurabile. | DECIDE / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-004 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire pipeline review, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AUT-001 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-SALES-MGR-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre forecast commit e best case, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-SALES-MGR-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio verificare follow-up e SLA lead, così da ottenere un risultato ripetibile per «verificare follow-up e sla lead» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AUT-001 | Routing accuracy, Median response time, SLA attainment | P2 / H2 |
| `ACC-JTBD-SALES-MGR-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio fare deal coaching e next best action, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AUT-001 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-SALES-MGR-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire deal bloccati ed escalation, così da ottenere un risultato ripetibile per «gestire deal bloccati ed escalation» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AUT-001 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio approvare sconti e richieste operative, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | GOVERN / L2 | HIGH | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-020 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-SALES-MGR-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare handoff a Customer e delivery, così da ottenere un risultato ripetibile per «coordinare handoff a customer e delivery» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AUT-001 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare conversione per rappresentante, così da ottenere un risultato ripetibile per «migliorare conversione per rappresentante» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-005 | Team quota attainment, Forecast accuracy, Stage conversion | P1 / H1 |
| `ACC-JTBD-SALES-MGR-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare territorio e distribuzione carichi, così da ottenere un risultato ripetibile per «ottimizzare territorio e distribuzione carichi» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-005 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre sales cycle e inattività, così da ottenere un risultato ripetibile per «ridurre sales cycle e inattività» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-005 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità di discovery e follow-up, così da ottenere un risultato ripetibile per «migliorare qualità di discovery e follow-up» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-005 | Team quota attainment, Forecast accuracy, Stage conversion | P2 / H2 |
| `ACC-JTBD-SALES-MGR-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere data hygiene e completezza opportunità, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | SAL-006, SAL-011, SAL-013, COL-004, COL-001, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-SALES-MGR-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare affidamento e override degli agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | GOVERN / L2 | HIGH | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-020 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-SALES-MGR-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere playbook con evidenze da call e deal, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-021 | Team quota attainment, Forecast accuracy, Stage conversion | P3 / H3 |
| `ACC-JTBD-SALES-MGR-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio sperimentare nuovi workflow agentici di team, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-006, SAL-011, SAL-013, COL-004, COL-001, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Account Executive (`PER-SALES-AE`)

**Missione:** Portare opportunità qualificate alla chiusura costruendo valore, consenso del buying committee e un processo d'acquisto controllato.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-AE-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare portafoglio, preferenze e working queue, così da ottenere un risultato ripetibile per «configurare portafoglio, preferenze e working queue» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, PLT-002 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio importare e riconciliare account e contatti assegnati, così da ottenere un risultato ripetibile per «importare e riconciliare account e contatti assegnati» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, PLT-002 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio personalizzare playbook per segmento e motion, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-AE-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire limiti di autonomia per comunicazioni e deal, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | CONFIGURE / L3 | HIGH | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, PLT-002 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-AE-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare account research e meeting brief, così da ottenere un risultato ripetibile per «preparare account research e meeting brief» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio mappare buying committee e relazioni, così da ottenere un risultato ripetibile per «mappare buying committee e relazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire discovery e catturare note strutturate, così da ottenere un risultato ripetibile per «eseguire discovery e catturare note strutturate» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio qualificare e aggiornare opportunità, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-AE-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare outreach e follow-up personalizzati, così da ottenere un risultato ripetibile per «preparare outreach e follow-up personalizzati» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire next step e mutual action plan, così da ottenere un risultato ripetibile per «gestire next step e mutual action plan» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AUT-001 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare proposta, quote e business case, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | CREATE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-011 | Quote turnaround, Contract cycle time, Rework rate | P2 / H2 |
| `ACC-JTBD-AE-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio aggiornare forecast e rischi del deal, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-AE-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare priorità e next best action, così da ottenere un risultato ripetibile per «migliorare priorità e next best action» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-005 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre tempo amministrativo e data entry, così da ottenere un risultato ripetibile per «ridurre tempo amministrativo e data entry» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-005 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare gestione obiezioni e concorrenza, così da ottenere un risultato ripetibile per «migliorare gestione obiezioni e concorrenza» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-005 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio identificare expansion nel portafoglio, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | INVESTIGATE / L2 | LOW | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-007 | Expansion ARR, Expansion conversion, Net revenue retention | P2 / H2 |
| `ACC-JTBD-AE-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere accuratezza e ownership dei record, così da ottenere un risultato ripetibile per «mantenere accuratezza e ownership dei record» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, DEV-010 | Win rate, Bookings, Sales cycle | P2 / H2 |
| `ACC-JTBD-AE-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare privacy, consenso e uso di contenuti AI, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | GOVERN / L2 | HIGH | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-020 | Content usage, Engagement quality, Influenced pipeline | P0 / H1 |
| `ACC-JTBD-AE-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio costruire nuovi play personali tramite agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-AE-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere il workspace AE con feedback d'uso, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | SAL-005, SAL-006, SAL-009, SAL-010, SAL-014, AIA-021 | Win rate, Bookings, Sales cycle | P3 / H3 |

## SDR / BDR (`PER-SALES-SDR`)

**Missione:** Creare conversazioni qualificate con gli account giusti, nel momento e sul canale appropriato, rispettando policy e ownership.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-SDR-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare territorio, ICP e code di lavoro, così da ottenere un risultato ripetibile per «configurare territorio, icp e code di lavoro» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, PLT-002 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio importare liste e regole di ownership, così da ottenere un risultato ripetibile per «importare liste e regole di ownership» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, PLT-002 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire qualificazione, sequence e SLA, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | CONFIGURE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, PLT-002 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-SDR-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare policy di contatto e opt-out, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | CONFIGURE / L3 | HIGH | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, PLT-002 | Qualified meetings, Reply rate, Meeting held rate | P0 / H1 |
| `ACC-JTBD-SDR-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire e arricchire target list, così da ottenere un risultato ripetibile per «costruire e arricchire target list» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prioritizzare prospect con intent e fit, così da ottenere un risultato ripetibile per «prioritizzare prospect con intent e fit» con dati affidabili, responsabilità chiare e impatto misurabile. | DECIDE / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-004 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio personalizzare outreach multicanale, così da ottenere un risultato ripetibile per «personalizzare outreach multicanale» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire sequence e task giornalieri, così da ottenere un risultato ripetibile per «eseguire sequence e task giornalieri» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare chiamate e gestire obiezioni, così da ottenere un risultato ripetibile per «preparare chiamate e gestire obiezioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio classificare risposte e intent, così da ottenere un risultato ripetibile per «classificare risposte e intent» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prenotare meeting e gestire no-show, così da ottenere un risultato ripetibile per «prenotare meeting e gestire no-show» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio qualificare e passare opportunità, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | EXECUTE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AUT-001 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-SDR-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare reply rate e meeting rate, così da ottenere un risultato ripetibile per «migliorare reply rate e meeting rate» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-005 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare timing, canale e messaggio, così da ottenere un risultato ripetibile per «ottimizzare timing, canale e messaggio» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-005 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre duplicati e contatti non eleggibili, così da ottenere un risultato ripetibile per «ridurre duplicati e contatti non eleggibili» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-005 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità degli handoff agli AE, così da ottenere un risultato ripetibile per «migliorare qualità degli handoff agli ae» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-005 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere dati, disposition e attività aggiornati, così da ottenere un risultato ripetibile per «mantenere dati, disposition e attività aggiornati» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, DEV-010 | Qualified meetings, Reply rate, Meeting held rate | P2 / H2 |
| `ACC-JTBD-SDR-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare consenso, frequency cap e claim AI, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-020 | Qualified meetings, Reply rate, Meeting held rate | P0 / H1 |
| `ACC-JTBD-SDR-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere sequence con test controllati, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | EVOLVE / L3 | MEDIUM | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-021 | Experiment velocity, Decision rate, Incremental lift | P3 / H3 |
| `ACC-JTBD-SDR-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio addestrare agenti SDR su esiti reali, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-002, SAL-004, SAL-008, MKT-020, COL-001, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Customer Value Manager / CSM (`PER-CUST-CVM`)

**Missione:** Guidare ogni cliente verso outcome misurabili, adozione, rinnovo ed espansione con interventi proporzionati al rischio.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CVM-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare portfolio, segmenti e coverage, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CVM-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio importare contratti, obiettivi e stakeholder, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | CONFIGURE / L3 | HIGH | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, PLT-002 | Quote turnaround, Contract cycle time, Rework rate | P0 / H1 |
| `ACC-JTBD-CVM-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire success plan e milestone, così da ottenere un risultato ripetibile per «definire success plan e milestone» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, PLT-002 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare health score, playbook e limiti agentici, così da distinguere segnali reali da rumore e attivare il play proporzionato. | CONFIGURE / L3 | HIGH | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, PLT-002 | Health score precision, Feature adoption, Risk play success rate | P0 / H1 |
| `ACC-JTBD-CVM-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio prioritizzare portfolio e task, così da ottenere un risultato ripetibile per «prioritizzare portfolio e task» con dati affidabili, responsabilità chiare e impatto misurabile. | DECIDE / L3 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-004 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire onboarding e time-to-value, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AUT-001 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-CVM-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare adozione, health e segnali di rischio, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MONITOR / L2 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CVM-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare outreach ed escalation, così da ottenere un risultato ripetibile per «coordinare outreach ed escalation» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AUT-001 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare QBR/EBR e stakeholder map, così da ottenere un risultato ripetibile per «preparare qbr/ebr e stakeholder map» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AUT-001 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio dimostrare ROI e value realization, così da ottenere un risultato ripetibile per «dimostrare roi e value realization» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AUT-001 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire rinnovo e piano di retention, così da intervenire prima che il rischio si materializzi e rendere prevedibile la retention. | EXECUTE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AUT-001 | Gross retention, Renewal forecast accuracy, At-risk ARR covered | P1 / H1 |
| `ACC-JTBD-CVM-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio identificare expansion e advocacy, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | INVESTIGATE / L2 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-007 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-CVM-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare adozione e outcome cliente, così da distinguere segnali reali da rumore e attivare il play proporzionato. | OPTIMIZE / L3 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-005 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CVM-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre churn e rischio non gestito, così da intervenire prima che il rischio si materializzi e rendere prevedibile la retention. | OPTIMIZE / L3 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-005 | Gross retention, Renewal forecast accuracy, At-risk ARR covered | P1 / H1 |
| `ACC-JTBD-CVM-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare frequenza e qualità dei touchpoint, così da ottenere un risultato ripetibile per «ottimizzare frequenza e qualità dei touchpoint» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-005 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare collaborazione con Support e Product, così da ottenere un risultato ripetibile per «migliorare collaborazione con support e product» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-005 | Time to value, Health score movement, Renewal rate | P2 / H2 |
| `ACC-JTBD-CVM-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere dati cliente, contratti e note affidabili, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | MAINTAIN / L3 | HIGH | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, DEV-010 | Quote turnaround, Contract cycle time, Rework rate | P0 / H1 |
| `ACC-JTBD-CVM-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare comunicazioni e azioni autonome, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | GOVERN / L2 | HIGH | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-020 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-CVM-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere playbook Customer con learning loop, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-021 | Time to value, Health score movement, Renewal rate | P3 / H3 |
| `ACC-JTBD-CVM-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare agenti specializzati per segmenti clienti, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EVOLVE / L3 | HIGH | CSV-002, CSV-004, CSV-005, CSV-007, CSV-022, AIA-021 | Eligible audience size, Match rate, Suppression accuracy | P1 / H2 |

## Sales Enablement Specialist (`PER-SALES-ENABLE`)

**Missione:** Ridurre il tempo necessario per diventare efficaci e rendere replicabili i comportamenti che aumentano win rate e qualità.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-ENABLE-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire competency model per ruolo, così da ottenere un risultato ripetibile per «definire competency model per ruolo» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, PLT-002 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio costruire onboarding e curriculum, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | CONFIGURE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, PLT-002 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-ENABLE-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio organizzare knowledge, playbook e content taxonomy, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | CONFIGURE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, PLT-002 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare metriche di adozione e proficiency, così da distinguere segnali reali da rumore e attivare il play proporzionato. | CONFIGURE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, PLT-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-ENABLE-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio raccomandare contenuti nel momento di vendita, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-ENABLE-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire playbook e battlecard, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare call e opportunità per coaching, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | INVESTIGATE / L2 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-007 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-ENABLE-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire certificazioni e readiness, così da ottenere un risultato ripetibile per «gestire certificazioni e readiness» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio supportare lanci di prodotto e processo, così da ottenere un risultato ripetibile per «supportare lanci di prodotto e processo» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio formare su CRM e workflow, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P1 / H2 |
| `ACC-JTBD-ENABLE-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio formare su uso sicuro degli agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EXECUTE / L2 | HIGH | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-ENABLE-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio raccogliere feedback dal campo, così da ottenere un risultato ripetibile per «raccogliere feedback dal campo» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AUT-001 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre ramp time, così da ottenere un risultato ripetibile per «ridurre ramp time» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-005 | Ramp time, Certification rate, Content usage | P2 / H2 |
| `ACC-JTBD-ENABLE-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare skill gap e coaching precision, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | OPTIMIZE / L3 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-005 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-ENABLE-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio misurare efficacia di contenuti e training, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | MONITOR / L2 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-002 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-ENABLE-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare adozione dei comportamenti vincenti, così da distinguere segnali reali da rumore e attivare il play proporzionato. | OPTIMIZE / L3 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-005 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-ENABLE-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere contenuti aggiornati e approvati, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | MAINTAIN / L3 | LOW | COL-004, COL-005, COL-011, SAL-018, AIA-012, DEV-010 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-ENABLE-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare claim, localizzazione e accessi, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-ENABLE-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio simulare conversazioni e deal per training, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | EVOLVE / L3 | MEDIUM | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-021 | Ramp time, Playbook adoption, Skill improvement | P3 / H3 |
| `ACC-JTBD-ENABLE-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere enablement con coach agentici, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | COL-004, COL-005, COL-011, SAL-018, AIA-012, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Customer Service Agent (`PER-SVC-AGENT`)

**Missione:** Risolvere richieste rapidamente e correttamente con pieno contesto cliente, rispettando SLA, sicurezza e tono.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-SERVICE-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare code, skill e canali assegnati, così da ottenere un risultato ripetibile per «configurare code, skill e canali assegnati» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, PLT-002 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire autenticazione, SLA e limiti operativi, così da ottenere un risultato ripetibile per «definire autenticazione, sla e limiti operativi» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, PLT-002 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare workspace e knowledge personale, così da ottenere un risultato ripetibile per «preparare workspace e knowledge personale» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, PLT-002 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare preferenze di agent assist, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | CONFIGURE / L3 | HIGH | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, PLT-002 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-SERVICE-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio identificare cliente e contesto 360, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | INVESTIGATE / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-007 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-SERVICE-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio triage e classificazione del caso, così da risolvere correttamente al primo contatto o escalare con contesto completo e SLA preservato. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AUT-001 | First contact resolution, Average handle time, CSAT | P1 / H1 |
| `ACC-JTBD-SERVICE-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio cercare conoscenza e precedenti, così da ottenere un risultato ripetibile per «cercare conoscenza e precedenti» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AUT-001 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio redigere risposta coerente e personalizzata, così da ottenere un risultato ripetibile per «redigere risposta coerente e personalizzata» con dati affidabili, responsabilità chiare e impatto misurabile. | CREATE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-011 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire risoluzioni standard, così da ottenere un risultato ripetibile per «eseguire risoluzioni standard» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AUT-001 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio instradare, escalare e fare swarming, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-005 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare SLA e follow-up, così da ottenere un risultato ripetibile per «monitorare sla e follow-up» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-002 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio riassumere e aggiornare caso e profilo, così da risolvere correttamente al primo contatto o escalare con contesto completo e SLA preservato. | EXECUTE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AUT-001 | First contact resolution, Average handle time, CSAT | P1 / H1 |
| `ACC-JTBD-SERVICE-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre tempo medio di gestione, così da ottenere un risultato ripetibile per «ridurre tempo medio di gestione» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-005 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare first contact resolution, così da ottenere un risultato ripetibile per «aumentare first contact resolution» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-005 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare tono, chiarezza e coerenza, così da ottenere un risultato ripetibile per «migliorare tono, chiarezza e coerenza» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-005 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio rilevare sentiment e rischio escalation, così da ottenere un risultato ripetibile per «rilevare sentiment e rischio escalation» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-002 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere note, disposition e knowledge affidabili, così da ottenere un risultato ripetibile per «mantenere note, disposition e knowledge affidabili» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, DEV-010 | First contact resolution, Average handle time, CSAT | P2 / H2 |
| `ACC-JTBD-SERVICE-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare autenticazione, rimborsi e dati sensibili, così da ottenere un risultato ripetibile per «governare autenticazione, rimborsi e dati sensibili» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | HIGH | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-020 | First contact resolution, Average handle time, CSAT | P0 / H1 |
| `ACC-JTBD-SERVICE-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio proporre nuovi articoli e workflow da casi ricorrenti, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EVOLVE / L3 | MEDIUM | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-021 | Workflow success rate, Cycle time reduction, Manual touches avoided | P2 / H2 |
| `ACC-JTBD-SERVICE-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere agent assist con feedback verificato, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | CSV-009, CSV-011, CSV-012, CSV-013, COL-001, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Partner / Channel Manager (`PER-CHANNEL-MGR`)

**Missione:** Sviluppare un ecosistema produttivo e governato, aumentando pipeline e ricavi sourced o influenced dai partner.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-PARTNER-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio segmentare partner e definire program tier, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-PARTNER-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare onboarding, certificazione e accessi, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | CONFIGURE / L3 | HIGH | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, PLT-002 | Time to first value, Milestone completion, Onboarding SLA | P0 / H1 |
| `ACC-JTBD-PARTNER-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire regole di deal registration e conflitto, così da ottenere un risultato ripetibile per «definire regole di deal registration e conflitto» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, PLT-002 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare incentivi, MDF e governance dati, così da ottenere un risultato ripetibile per «impostare incentivi, mdf e governance dati» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, PLT-002 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio reclutare e qualificare partner, così da separare fit, intent e readiness usando criteri espliciti, spiegabili e versionati. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Qualification acceptance rate, False-positive rate, Stage conversion | P1 / H1 |
| `ACC-JTBD-PARTNER-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire account mapping e whitespace, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio distribuire lead e opportunità, così da ottenere un risultato ripetibile per «distribuire lead e opportunità» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare co-sell e account plan, così da coordinare ecosistema, ownership e incentivi senza conflitti o perdita di visibilità. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire co-marketing e campagne, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-PARTNER-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare pipeline e forecast partner, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | MONITOR / L2 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-002 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-PARTNER-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio risolvere conflitti di canale, così da ottenere un risultato ripetibile per «risolvere conflitti di canale» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio supportare partner e richieste operative, così da coordinare ecosistema, ownership e incentivi senza conflitti o perdita di visibilità. | EXECUTE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AUT-001 | Partner-sourced pipeline, Deal registration SLA, Partner activation | P2 / H2 |
| `ACC-JTBD-PARTNER-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare activation e produttività partner, così da coordinare ecosistema, ownership e incentivi senza conflitti o perdita di visibilità. | OPTIMIZE / L3 | LOW | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-005 | Partner-sourced pipeline, Deal registration SLA, Partner activation | P2 / H2 |
| `ACC-JTBD-PARTNER-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare incentivi e redditività, così da ottenere un risultato ripetibile per «ottimizzare incentivi e redditività» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-005 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare qualità del pipeline sourced/influenced, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | OPTIMIZE / L3 | LOW | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-005 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-PARTNER-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre tempi di onboarding e registrazione, così da portare il cliente al primo valore misurabile con milestone, dipendenze e responsabilità chiare. | OPTIMIZE / L3 | LOW | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-005 | Time to first value, Milestone completion, Onboarding SLA | P2 / H2 |
| `ACC-JTBD-PARTNER-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere certificazioni, dati e integrazioni, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | MAINTAIN / L3 | LOW | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, DEV-010 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-PARTNER-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare compliance, consensi e segregazione, così da ottenere un risultato ripetibile per «governare compliance, consensi e segregazione» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | HIGH | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-020 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P0 / H1 |
| `ACC-JTBD-PARTNER-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare play agentici di co-selling, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-PARTNER-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere ecosistema e marketplace di capability, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | SAL-021, FIN-012, COL-011, MKT-024, DAT-007, AIA-021 | Partner-sourced pipeline, Activated partners, Deal registration SLA | P2 / H2 |

## Performance Marketing Specialist (`PER-MKT-PERF`)

**Missione:** Investire il budget media dove genera crescita incrementale e clienti di valore, con misurazione closed-loop.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-PERF-MKT-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire measurement plan e conversion taxonomy, così da ottenere un risultato ripetibile per «definire measurement plan e conversion taxonomy» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, PLT-002 | Incremental ROAS, CAC, Cost per opportunity | P1 / H1 |
| `ACC-JTBD-PERF-MKT-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare account pubblicitari, analytics e CRM, così da ottenere un risultato ripetibile per «collegare account pubblicitari, analytics e crm» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, PLT-002 | Incremental ROAS, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-PERF-MKT-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare audience, eventi e offline conversion, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P1 / H1 |
| `ACC-JTBD-PERF-MKT-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare budget, guardrail e brand safety, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | CONFIGURE / L3 | HIGH | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, PLT-002 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-PERF-MKT-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio pianificare campagne e channel mix, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-PERF-MKT-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio attivare audience e creatività, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EXECUTE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AUT-001 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-PERF-MKT-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare pacing, spesa e delivery, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | MONITOR / L2 | HIGH | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-002 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-PERF-MKT-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio rilevare anomalie e tracking break, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | MONITOR / L2 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-002 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-PERF-MKT-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire bid, budget e allocazioni, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | EXECUTE / L2 | HIGH | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AUT-001 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-PERF-MKT-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio allineare annunci, landing e offerte, così da ottenere un risultato ripetibile per «allineare annunci, landing e offerte» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AUT-001 | Incremental ROAS, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-PERF-MKT-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio misurare lead quality e revenue outcome, così da ottenere un risultato ripetibile per «misurare lead quality e revenue outcome» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-002 | Incremental ROAS, CAC, Cost per opportunity | P1 / H1 |
| `ACC-JTBD-PERF-MKT-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre report e decision packet, così da ottenere un risultato ripetibile per «produrre report e decision packet» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AUT-001 | Incremental ROAS, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-PERF-MKT-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare CAC, ROAS e payback, così da ottenere un risultato ripetibile per «ottimizzare cac, roas e payback» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-005 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-PERF-MKT-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio valutare incrementality e attribuzione, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | INVESTIGATE / L2 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-007 | Incremental ROAS, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-PERF-MKT-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare retargeting e suppression, così da ottenere un risultato ripetibile per «migliorare retargeting e suppression» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-005 | Incremental ROAS, CAC, Cost per opportunity | P2 / H2 |
| `ACC-JTBD-PERF-MKT-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio sperimentare creatività, audience e landing, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | OPTIMIZE / L3 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-005 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-PERF-MKT-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere tracking, naming e data freshness, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-PERF-MKT-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare privacy, fraud e azioni automatiche, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-PERF-MKT-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio costruire optimizer agentici con limiti di spesa, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-PERF-MKT-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere activation e closed-loop measurement, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | MKT-007, MKT-013, MKT-015, MKT-016, AIA-006, AIA-021 | Incremental ROAS, CAC, Cost per opportunity | P3 / H3 |

## Content Marketing Manager (`PER-MKT-CONTENT`)

**Missione:** Produrre e distribuire contenuti autorevoli e riusabili che rispondono ai bisogni del mercato e influenzano pipeline e adozione.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CONTENT-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire audience, content pillar e obiettivi, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CONTENT-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare editorial workflow e taxonomy, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | CONFIGURE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, PLT-002 | Workflow success rate, Cycle time reduction, Manual touches avoided | P2 / H2 |
| `ACC-JTBD-CONTENT-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare CMS, DAM, SEO e CRM, così da ottenere un risultato ripetibile per «collegare cms, dam, seo e crm» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, PLT-002 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare brand, fonti e policy per AI, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | CONFIGURE / L3 | HIGH | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, PLT-002 | Content-influenced pipeline, Organic demand, Engagement quality | P0 / H1 |
| `ACC-JTBD-CONTENT-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio ricercare temi, domande e content gap, così da ottenere un risultato ripetibile per «ricercare temi, domande e content gap» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio creare brief basati su insight cliente, così da ottenere un risultato ripetibile per «creare brief basati su insight cliente» con dati affidabili, responsabilità chiare e impatto misurabile. | CREATE / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-013 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre bozze e varianti, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | CREATE / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-013 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare SME, legal e approvazioni, così da ottenere un risultato ripetibile per «coordinare sme, legal e approvazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio pubblicare e distribuire contenuti, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-CONTENT-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio riutilizzare e localizzare asset, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-CONTENT-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio personalizzare contenuti per journey e account, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-CONTENT-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio fornire contenuti a Sales e Customer, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | EXECUTE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AUT-001 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-CONTENT-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità, SEO e engagement, così da ottenere un risultato ripetibile per «migliorare qualità, seo e engagement» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-005 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare mix e distribuzione, così da ottenere un risultato ripetibile per «ottimizzare mix e distribuzione» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-005 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio misurare pipeline e revenue influence, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | MONITOR / L2 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-002 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-CONTENT-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre time-to-publish e sprechi, così da ottenere un risultato ripetibile per «ridurre time-to-publish e sprechi» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-005 | Content-influenced pipeline, Organic demand, Engagement quality | P2 / H2 |
| `ACC-JTBD-CONTENT-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere freshness, diritti e versioni, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-CONTENT-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare claim, citazioni e contenuti generativi, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | GOVERN / L2 | HIGH | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-020 | Content usage, Engagement quality, Influenced pipeline | P0 / H1 |
| `ACC-JTBD-CONTENT-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare content agent specializzati, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-CONTENT-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere knowledge graph e recommendation engine, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | MKT-009, MKT-010, MKT-017, MKT-025, AIA-011, AIA-021 | Content-influenced pipeline, Organic demand, Engagement quality | P3 / H3 |

## Campaign & Lifecycle Manager (`PER-MKT-CAMPAIGN`)

**Missione:** Portare campagne e journey dal brief al risultato con segmentazione corretta, orchestration affidabile e learning continuo.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CAMPAIGN-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire campaign brief, obiettivi e owner, così da ottenere un risultato ripetibile per «definire campaign brief, obiettivi e owner» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, PLT-002 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare audience, esclusioni e consenso, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | HIGH | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P0 / H1 |
| `ACC-JTBD-CAMPAIGN-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare journey, trigger e canali, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | CONFIGURE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, PLT-002 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare QA, approvazioni e guardrail, così da ottenere un risultato ripetibile per «impostare qa, approvazioni e guardrail» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, PLT-002 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire segmenti e personalizzazioni, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio assemblare contenuti e template, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare workflow, timing e frequency cap, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P1 / H2 |
| `ACC-JTBD-CAMPAIGN-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio lanciare campagne multicanale, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare delivery e conversioni, così da ottenere un risultato ripetibile per «monitorare delivery e conversioni» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-002 | Campaign conversion, Incremental lift, Pipeline/revenue | P1 / H1 |
| `ACC-JTBD-CAMPAIGN-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire anomalie e pause, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio governare nurture e lead lifecycle, così da ottenere un risultato ripetibile per «governare nurture e lead lifecycle» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-020 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare handoff a Sales e Customer, così da ottenere un risultato ripetibile per «coordinare handoff a sales e customer» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare conversione e incremental lift, così da ottenere un risultato ripetibile per «ottimizzare conversione e incremental lift» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-005 | Campaign conversion, Incremental lift, Pipeline/revenue | P1 / H1 |
| `ACC-JTBD-CAMPAIGN-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare timing, canale e pressione, così da ottenere un risultato ripetibile per «migliorare timing, canale e pressione» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-005 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre errori e tempi di produzione, così da ottenere un risultato ripetibile per «ridurre errori e tempi di produzione» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-005 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio riattivare, rinnovare ed espandere clienti, così da ottenere un risultato ripetibile per «riattivare, rinnovare ed espandere clienti» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AUT-001 | Campaign conversion, Incremental lift, Pipeline/revenue | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere template, audience e tracking, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | MAINTAIN / L3 | LOW | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, DEV-010 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CAMPAIGN-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare consenso, brand e approvazioni, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-020 | Campaign conversion, Incremental lift, Pipeline/revenue | P0 / H1 |
| `ACC-JTBD-CAMPAIGN-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare journey auto-ottimizzanti controllati, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | EVOLVE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-021 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P3 / H3 |
| `ACC-JTBD-CAMPAIGN-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere libreria di campaign blueprint, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | MKT-001, MKT-003, MKT-005, MKT-021, AUT-002, AIA-021 | Campaign conversion, Incremental lift, Pipeline/revenue | P3 / H3 |

## CRO / Conversion Optimization Specialist (`PER-GROWTH-CRO`)

**Missione:** Aumentare la conversione sostenibile rimuovendo frizioni e validando causalmente le modifiche all'esperienza.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CRO-SPEC-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire funnel, eventi e measurement plan, così da ottenere un risultato ripetibile per «definire funnel, eventi e measurement plan» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, PLT-002 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare analytics, session data e CRM outcome, così da ottenere un risultato ripetibile per «collegare analytics, session data e crm outcome» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, PLT-002 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio costruire backlog di ipotesi, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | CONFIGURE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, PLT-002 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare processo sperimentale e guardrail, così da ottenere un risultato ripetibile per «impostare processo sperimentale e guardrail» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, PLT-002 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio diagnosticare drop-off e frizioni, così da ottenere un risultato ripetibile per «diagnosticare drop-off e frizioni» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-007 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio condurre ricerca quantitativa e qualitativa, così da ottenere un risultato ripetibile per «condurre ricerca quantitativa e qualitativa» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AUT-001 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio progettare esperimenti e segmenti, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EXECUTE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AUT-001 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio creare varianti di landing, form e CTA, così da ottenere un risultato ripetibile per «creare varianti di landing, form e cta» con dati affidabili, responsabilità chiare e impatto misurabile. | CREATE / L3 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-011 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire QA di tracking ed esperienza, così da ottenere un risultato ripetibile per «eseguire qa di tracking ed esperienza» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AUT-001 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio lanciare e monitorare test, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | MONITOR / L2 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-002 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare risultati e causalità, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | INVESTIGATE / L2 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-007 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio documentare learning e decisioni, così da ottenere un risultato ripetibile per «documentare learning e decisioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AUT-001 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare conversione per segmento, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | OPTIMIZE / L3 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Eligible audience size, Match rate, Suppression accuracy | P1 / H1 |
| `ACC-JTBD-CRO-SPEC-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre attrito e campi non necessari, così da ottenere un risultato ripetibile per «ridurre attrito e campi non necessari» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare velocità, accessibilità e mobile, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | OPTIMIZE / L3 | HIGH | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Policy violation rate, Audit completeness, Access review SLA | P1 / H1 |
| `ACC-JTBD-CRO-SPEC-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio scalare personalizzazione vincente, così da ottenere un risultato ripetibile per «scalare personalizzazione vincente» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Conversion lift, Experiment velocity, Revenue per visitor | P2 / H2 |
| `ACC-JTBD-CRO-SPEC-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere integrità esperimenti e identity, così da riconoscere la stessa persona o organizzazione senza merge impropri e con reversibilità. | MAINTAIN / L3 | HIGH | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, DEV-010 | Identity match precision, False merge rate, Profile coverage | P0 / H1 |
| `ACC-JTBD-CRO-SPEC-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare significatività, privacy e rollout, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | GOVERN / L2 | HIGH | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-CRO-SPEC-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio generare ipotesi e varianti con agenti, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | EVOLVE / L3 | HIGH | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-CRO-SPEC-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere experimentation platform e knowledge base, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | MKT-013, MKT-022, AIA-005, AIA-003, DAT-005, AIA-021 | Conversion lift, Experiment velocity, Revenue per visitor | P3 / H3 |

## ABM Manager (`PER-MKT-ABM`)

**Missione:** Creare engagement coordinato e rilevante nei target account, collegando intent, buying committee, seller action e pipeline.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-ABM-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire ICP, account universe e tier, così da ottenere un risultato ripetibile per «definire icp, account universe e tier» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, PLT-002 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare intent, firmographic e CRM, così da ottenere un risultato ripetibile per «collegare intent, firmographic e crm» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, PLT-002 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare buying committee e ownership, così da ottenere un risultato ripetibile per «configurare buying committee e ownership» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, PLT-002 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare play, SLA e misurazione account-based, così da ottenere un risultato ripetibile per «impostare play, sla e misurazione account-based» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, PLT-002 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio selezionare e priorizzare target account, così da ottenere un risultato ripetibile per «selezionare e priorizzare target account» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio mappare buying committee e relazioni, così da ottenere un risultato ripetibile per «mappare buying committee e relazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio creare account plan e value hypothesis, così da ottenere un risultato ripetibile per «creare account plan e value hypothesis» con dati affidabili, responsabilità chiare e impatto misurabile. | CREATE / L3 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-011 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio orchestrare ad, content e seller touch, così da ottenere un risultato ripetibile per «orchestrare ad, content e seller touch» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio inviare alert di intent e next best action, così da ottenere un risultato ripetibile per «inviare alert di intent e next best action» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare meeting e follow-up, così da ottenere un risultato ripetibile per «coordinare meeting e follow-up» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare engagement e progression, così da ottenere un risultato ripetibile per «monitorare engagement e progression» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-002 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio misurare pipeline sourced e influenced, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | MONITOR / L2 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-002 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-ABM-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare tiering e copertura, così da ottenere un risultato ripetibile per «ottimizzare tiering e copertura» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-005 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare personalizzazione e relevance, così da ottenere un risultato ripetibile per «migliorare personalizzazione e relevance» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-005 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre spreco su account non eleggibili, così da ottenere un risultato ripetibile per «ridurre spreco su account non eleggibili» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-005 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio espandere ABM su clienti e partner, così da coordinare ecosistema, ownership e incentivi senza conflitti o perdita di visibilità. | EXECUTE / L3 | MEDIUM | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AUT-001 | Partner-sourced pipeline, Deal registration SLA, Partner activation | P2 / H2 |
| `ACC-JTBD-ABM-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere enrichment, ownership e consent, così da ottenere un risultato ripetibile per «mantenere enrichment, ownership e consent» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, DEV-010 | Engaged target accounts, Account progression, ABM pipeline | P2 / H2 |
| `ACC-JTBD-ABM-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare contatto, claim e data sharing, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | GOVERN / L2 | HIGH | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-020 | Engaged target accounts, Account progression, ABM pipeline | P0 / H1 |
| `ACC-JTBD-ABM-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio automatizzare account research con agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-ABM-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere multi-agent account orchestration, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | MKT-018, DAT-016, DAT-022, SAL-019, MKT-011, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Product Marketing Manager (`PER-MKT-PMM`)

**Missione:** Tradurre mercato, clienti e prodotto in positioning, messaggi, prove e lanci che aumentano adozione e win rate.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-PMM-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire segmentazione, ICP e persona, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | CONFIGURE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, PLT-002 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-PMM-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare repository di insight e prove, così da ottenere un risultato ripetibile per «configurare repository di insight e prove» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, PLT-002 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio costruire positioning e messaging framework, così da ottenere un risultato ripetibile per «costruire positioning e messaging framework» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, PLT-002 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare processo launch e feedback loop, così da ottenere un risultato ripetibile per «impostare processo launch e feedback loop» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, PLT-002 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare mercato, clienti e concorrenti, così da ottenere un risultato ripetibile per «monitorare mercato, clienti e concorrenti» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-002 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio preparare launch plan e asset, così da produrre artefatti pertinenti, coerenti con brand e fonti, approvati e riutilizzabili. | CREATE / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-011 | Content usage, Engagement quality, Influenced pipeline | P2 / H2 |
| `ACC-JTBD-PMM-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio creare battlecard e objection handling, così da ottenere un risultato ripetibile per «creare battlecard e objection handling» con dati affidabili, responsabilità chiare e impatto misurabile. | CREATE / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-011 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio abilitare Sales, Partner e Customer, così da coordinare ecosistema, ownership e incentivi senza conflitti o perdita di visibilità. | EXECUTE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AUT-001 | Partner-sourced pipeline, Deal registration SLA, Partner activation | P2 / H2 |
| `ACC-JTBD-PMM-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio raccogliere proof, case study e referenze, così da ottenere un risultato ripetibile per «raccogliere proof, case study e referenze» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AUT-001 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio supportare pricing e packaging, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | EXECUTE / L2 | HIGH | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AUT-001 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-PMM-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare win/loss e deal feedback, così da ottenere un risultato ripetibile per «analizzare win/loss e deal feedback» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-007 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare adozione e percezione delle feature, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MONITOR / L2 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-002 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-PMM-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare messaggi per segmento, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | OPTIMIZE / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-005 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-PMM-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare launch effectiveness, così da ottenere un risultato ripetibile per «ottimizzare launch effectiveness» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-005 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio identificare gap di prodotto e domanda, così da ottenere un risultato ripetibile per «identificare gap di prodotto e domanda» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-007 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare riuso e coerenza delle prove, così da ottenere un risultato ripetibile per «aumentare riuso e coerenza delle prove» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-005 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere intelligence, fonti e versioni, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | MAINTAIN / L3 | LOW | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, DEV-010 | Launch adoption, Win rate, Message resonance | P2 / H2 |
| `ACC-JTBD-PMM-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare claim e sintesi generate da AI, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | GOVERN / L2 | HIGH | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-020 | Launch adoption, Win rate, Message resonance | P0 / H1 |
| `ACC-JTBD-PMM-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare market intelligence agentica, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-PMM-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere roadmap con evidence synthesis, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | SAL-020, MKT-009, COL-005, CSV-021, AIA-013, AIA-021 | Launch adoption, Win rate, Message resonance | P2 / H2 |

## Data Engineering Manager (`PER-DATA-ENG`)

**Missione:** Fornire dati cliente affidabili, freschi, tracciabili e sostenibili per analytics, workflow e agenti.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-DATA-ENG-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio inventariare fonti, owner e SLA, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | CONFIGURE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, PLT-002 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire architettura e canonical customer model, così da ottenere un risultato ripetibile per «definire architettura e canonical customer model» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, PLT-002 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio stabilire data contract e schema registry, così da ottenere un risultato ripetibile per «stabilire data contract e schema registry» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, PLT-002 | Data freshness SLA, Pipeline success rate, Data quality score | P0 / H1 |
| `ACC-JTBD-DATA-ENG-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare ambienti, accessi e deployment, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | CONFIGURE / L3 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, PLT-002 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-DATA-ENG-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire ingestion batch e CDC, così da ottenere un risultato ripetibile per «costruire ingestion batch e cdc» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire streaming di eventi, così da ottenere un risultato ripetibile per «costruire streaming di eventi» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio implementare identity resolution e stitching, così da riconoscere la stessa persona o organizzazione senza merge impropri e con reversibilità. | EXECUTE / L2 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Identity match precision, False merge rate, Profile coverage | P0 / H1 |
| `ACC-JTBD-DATA-ENG-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio trasformare e normalizzare dati, così da ottenere un risultato ripetibile per «trasformare e normalizzare dati» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio pubblicare dati verso CRM e activation, così da ottenere un risultato ripetibile per «pubblicare dati verso crm e activation» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio orchestrare pipeline e dipendenze, così da rendere visibili copertura, qualità, velocità, leakage e rischi con owner e next step. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Pipeline coverage, Stage conversion, Pipeline velocity | P1 / H1 |
| `ACC-JTBD-DATA-ENG-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare freshness, volumi e qualità, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MONITOR / L2 | LOW | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-002 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-DATA-ENG-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire incidenti, retry e backfill, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | EXECUTE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-DATA-ENG-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare costi e performance, così da ottenere un risultato ripetibile per «ottimizzare costi e performance» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-005 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre duplicati e inconsistenze, così da ottenere un risultato ripetibile per «ridurre duplicati e inconsistenze» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-005 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare lineage e osservabilità, così da ottenere un risultato ripetibile per «migliorare lineage e osservabilità» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-005 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio gestire evoluzione schema senza downtime, così da ottenere un risultato ripetibile per «gestire evoluzione schema senza downtime» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L2 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AUT-001 | Data freshness SLA, Pipeline success rate, Data quality score | P1 / H1 |
| `ACC-JTBD-DATA-ENG-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere sicurezza, PII e retention, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | MAINTAIN / L3 | LOW | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, DEV-010 | Data freshness SLA, Pipeline success rate, Data quality score | P2 / H2 |
| `ACC-JTBD-DATA-ENG-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare change, compatibilità e ownership, così da ottenere un risultato ripetibile per «governare change, compatibilità e ownership» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-020 | Data freshness SLA, Pipeline success rate, Data quality score | P0 / H1 |
| `ACC-JTBD-DATA-ENG-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare data product e connector pack, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EVOLVE / L3 | MEDIUM | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-021 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P3 / H3 |
| `ACC-JTBD-DATA-ENG-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere piattaforma dati per agenti real-time, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | DAT-017, DAT-018, DEV-016, DEV-017, DEV-021, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Data Analytics / BI Expert (`PER-DATA-ANALYTICS`)

**Missione:** Trasformare dati certificati in decisioni comprensibili, ripetibili e tempestive per ogni funzione revenue.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-ANALYTICS-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire metriche, dimensioni e owner, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CONFIGURE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, PLT-002 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-ANALYTICS-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio costruire semantic layer e glossario, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CONFIGURE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, PLT-002 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-ANALYTICS-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare accessi e certificazione dashboard, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CONFIGURE / L3 | HIGH | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, PLT-002 | Metric reconciliation variance, Dashboard adoption, Time to insight | P0 / H1 |
| `ACC-JTBD-ANALYTICS-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare fonti e validare riconciliazioni, così da comunicare solo affermazioni approvate, supportate da fonti e coerenti con il contesto. | CONFIGURE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, PLT-002 | Time to insight, Dashboard adoption, Metric reconciliation | P2 / H2 |
| `ACC-JTBD-ANALYTICS-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio creare dashboard operative ed executive, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CREATE / L3 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-011 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-ANALYTICS-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare funnel e conversioni, così da ottenere un risultato ripetibile per «analizzare funnel e conversioni» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-024 | Time to insight, Dashboard adoption, Metric reconciliation | P1 / H1 |
| `ACC-JTBD-ANALYTICS-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare cohort, retention e expansion, così da individuare crescita coerente con valore, adozione e stakeholder del cliente. | INVESTIGATE / L2 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-024 | Expansion ARR, Expansion conversion, Net revenue retention | P2 / H2 |
| `ACC-JTBD-ANALYTICS-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio segmentare clienti e account, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | EXECUTE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AUT-001 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-ANALYTICS-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio produrre forecast e scenario analysis, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-004 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-ANALYTICS-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio rilevare anomalie e root cause, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | MONITOR / L2 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-008 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-ANALYTICS-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio misurare campagne e attribuzione, così da portare il piano all'esecuzione multicanale senza errori, con misurazione e possibilità di pausa. | MONITOR / L2 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-008 | Incremental conversion, Revenue/pipeline influenced, Delivery success rate | P2 / H2 |
| `ACC-JTBD-ANALYTICS-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare performance Sales e Customer, così da ottenere un risultato ripetibile per «analizzare performance sales e customer» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-024 | Time to insight, Dashboard adoption, Metric reconciliation | P2 / H2 |
| `ACC-JTBD-ANALYTICS-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare self-service e time-to-insight, così da risolvere correttamente al primo contatto o escalare con contesto completo e SLA preservato. | OPTIMIZE / L3 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-005 | Time to insight, Dashboard adoption, Metric reconciliation | P2 / H2 |
| `ACC-JTBD-ANALYTICS-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare alert e decision narrative, così da ottenere un risultato ripetibile per «ottimizzare alert e decision narrative» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-005 | Time to insight, Dashboard adoption, Metric reconciliation | P2 / H2 |
| `ACC-JTBD-ANALYTICS-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio valutare esperimenti e causalità, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | INVESTIGATE / L2 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-024 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-ANALYTICS-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare affidabilità e adozione dei dati, così da distinguere segnali reali da rumore e attivare il play proporzionato. | OPTIMIZE / L3 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-005 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-ANALYTICS-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere qualità, freshness e query performance, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | MAINTAIN / L3 | LOW | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, DEV-010 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-ANALYTICS-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare metriche, accessi e uso responsabile, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | GOVERN / L2 | HIGH | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-020 | Metric reconciliation variance, Dashboard adoption, Time to insight | P0 / H1 |
| `ACC-JTBD-ANALYTICS-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio abilitare natural language analytics con evidenze, così da ottenere un risultato ripetibile per «abilitare natural language analytics con evidenze» con dati affidabili, responsabilità chiare e impatto misurabile. | EVOLVE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-021 | Time to insight, Dashboard adoption, Metric reconciliation | P3 / H3 |
| `ACC-JTBD-ANALYTICS-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere decision intelligence e proactive insight, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | AIA-001, AIA-002, AIA-003, AIA-007, DAT-012, AIA-021 | Time to insight, Dashboard adoption, Metric reconciliation | P3 / H3 |

## Data Scientist / ML Engineer (`PER-DATA-SCI`)

**Missione:** Costruire modelli che migliorano decisioni e azioni CRM, misurando utility reale, rischio e drift.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-DATA-SCI-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire problema, decisione e valore atteso, così da ottenere un risultato ripetibile per «definire problema, decisione e valore atteso» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, PLT-002 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare label, dataset e feature, così da ottenere un risultato ripetibile per «preparare label, dataset e feature» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, PLT-002 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio stabilire baseline, metriche e holdout, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | CONFIGURE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, PLT-002 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-DATA-SCI-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio disegnare governance e deployment model, così da ottenere un risultato ripetibile per «disegnare governance e deployment model» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | HIGH | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, PLT-002 | Decision utility, Model calibration, Lift/uplift | P0 / H1 |
| `ACC-JTBD-DATA-SCI-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire lead e account scoring, così da ottenere un risultato ripetibile per «costruire lead e account scoring» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio predire churn, renewal e rischio, così da intervenire prima che il rischio si materializzi e rendere prevedibile la retention. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Gross retention, Renewal forecast accuracy, At-risk ARR covered | P1 / H1 |
| `ACC-JTBD-DATA-SCI-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio stimare propensity e next best action, così da ottenere un risultato ripetibile per «stimare propensity e next best action» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire forecast e scenari, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | DECIDE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, COL-015 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-DATA-SCI-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio classificare intent, sentiment e conversazioni, così da ottenere un risultato ripetibile per «classificare intent, sentiment e conversazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire recommendation e ranking, così da ottenere un risultato ripetibile per «costruire recommendation e ranking» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio stimare uplift e treatment effect, così da ottenere un risultato ripetibile per «stimare uplift e treatment effect» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio servire modelli nei workflow CRM, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P1 / H2 |
| `ACC-JTBD-DATA-SCI-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare accuratezza, calibration e utility, così da ottenere un risultato ripetibile per «migliorare accuratezza, calibration e utility» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AIA-005 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre bias, drift e leakage, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | OPTIMIZE / L3 | LOW | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AIA-005 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare costo e latenza di inferenza, così da ottenere un risultato ripetibile per «ottimizzare costo e latenza di inferenza» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AIA-005 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio chiudere feedback loop con outcome reali, così da ottenere un risultato ripetibile per «chiudere feedback loop con outcome reali» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AUT-001 | Decision utility, Model calibration, Lift/uplift | P2 / H2 |
| `ACC-JTBD-DATA-SCI-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere monitoring, retraining e rollback, così da rendere replicabili i comportamenti efficaci e misurarne l'adozione sul risultato. | MAINTAIN / L3 | LOW | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, DEV-010 | Ramp time, Playbook adoption, Skill improvement | P2 / H2 |
| `ACC-JTBD-DATA-SCI-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare explainability, fairness e approvazioni, così da ottenere un risultato ripetibile per «governare explainability, fairness e approvazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | HIGH | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, AIA-020 | Decision utility, Model calibration, Lift/uplift | P0 / H1 |
| `ACC-JTBD-DATA-SCI-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare evaluation harness per agenti e modelli, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, DEV-009 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-DATA-SCI-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere learning system e policy di auto-ottimizzazione, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | HIGH | AIA-004, AIA-009, AIA-010, AIA-021, AIA-024, DEV-009 | Decision utility, Model calibration, Lift/uplift | P3 / H3 |

## CRM/CDP Administrator (`PER-PLAT-ADMIN`)

**Missione:** Mantenere Accordo configurato, sicuro, affidabile e facile da usare, senza introdurre bypass o debito operativo.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-CRM-ADMIN-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare tenant, business unit e workspace, così da ottenere un risultato ripetibile per «configurare tenant, business unit e workspace» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, PLT-012 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio creare utenti, ruoli e permessi, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | CONFIGURE / L3 | HIGH | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, PLT-012 | Change success rate, Admin request cycle time, Data quality | P0 / H1 |
| `ACC-JTBD-CRM-ADMIN-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare entità, campi, relazioni e layout, così da ottenere un risultato ripetibile per «configurare entità, campi, relazioni e layout» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, PLT-012 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare sandbox, dati seed e change process, così da ottenere un risultato ripetibile per «preparare sandbox, dati seed e change process» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, PLT-012 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire import, export e bulk update, così da ottenere un risultato ripetibile per «gestire import, export e bulk update» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare validation, managed field e regole, così da ottenere un risultato ripetibile per «configurare validation, managed field e regole» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare assignment, code e notifiche, così da ottenere un risultato ripetibile per «configurare assignment, code e notifiche» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire workflow e approval, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Workflow success rate, Cycle time reduction, Manual touches avoided | P1 / H2 |
| `ACC-JTBD-CRM-ADMIN-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire template, viste e dashboard, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio collegare integrazioni e credenziali, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare job, errori e utilizzo, così da distinguere segnali reali da rumore e attivare il play proporzionato. | MONITOR / L2 | LOW | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-002 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio risolvere problemi e richieste utenti, così da ottenere un risultato ripetibile per «risolvere problemi e richieste utenti» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare UX e adozione per ruolo, così da distinguere segnali reali da rumore e attivare il play proporzionato. | OPTIMIZE / L3 | LOW | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-005 | Health score precision, Feature adoption, Risk play success rate | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre duplicati e dati incompleti, così da ottenere un risultato ripetibile per «ridurre duplicati e dati incompleti» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-005 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare performance e limiti, così da ottenere un risultato ripetibile per «ottimizzare performance e limiti» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-005 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio automatizzare attività amministrative ripetitive, così da ottenere un risultato ripetibile per «automatizzare attività amministrative ripetitive» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AUT-001 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere backup, retention e documentazione, così da ottenere un risultato ripetibile per «mantenere backup, retention e documentazione» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, DEV-010 | Change success rate, Admin request cycle time, Data quality | P2 / H2 |
| `ACC-JTBD-CRM-ADMIN-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare release, audit e segregation of duties, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-CRM-ADMIN-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare configuration pack riusabili, così da ottenere un risultato ripetibile per «creare configuration pack riusabili» con dati affidabili, responsabilità chiare e impatto misurabile. | EVOLVE / L3 | MEDIUM | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-021 | Change success rate, Admin request cycle time, Data quality | P3 / H3 |
| `ACC-JTBD-CRM-ADMIN-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere amministrazione tramite builder agentico, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | PLT-016, PLT-006, PLT-002, AUT-013, GOV-006, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Integration / API Developer (`PER-DEV-INTEGRATION`)

**Missione:** Collegare Accordo in modo sicuro e affidabile a sistemi, eventi e strumenti esterni, preservando contratti e consistenza.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-INTEGRATION-DEV-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio analizzare API, eventi e requisiti di sync, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | CONFIGURE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, PLT-002 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire auth, mapping e ownership, così da ottenere un risultato ripetibile per «definire auth, mapping e ownership» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, PLT-002 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio progettare contratto, idempotenza e conflitti, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | CONFIGURE / L3 | HIGH | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, PLT-002 | Quote turnaround, Contract cycle time, Rework rate | P0 / H1 |
| `ACC-JTBD-INTEGRATION-DEV-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare sandbox, fixture e test plan, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | CONFIGURE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, PLT-002 | Experiment velocity, Decision rate, Incremental lift | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio costruire connettori e adapter, così da ottenere un risultato ripetibile per «costruire connettori e adapter» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio implementare webhook e event subscription, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire sync bidirezionale, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio implementare bulk import e backfill, così da ottenere un risultato ripetibile per «implementare bulk import e backfill» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire retry, rate limit e dead-letter, così da ottenere un risultato ripetibile per «gestire retry, rate limit e dead-letter» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio risolvere conflitti e ordering, così da ottenere un risultato ripetibile per «risolvere conflitti e ordering» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio esporre custom action e tool agentici, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EXECUTE / L2 | HIGH | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-INTEGRATION-DEV-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio documentare API e runbook, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare latenza e throughput, così da ottenere un risultato ripetibile per «migliorare latenza e throughput» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-005 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre errori e data loss, così da ottenere un risultato ripetibile per «ridurre errori e data loss» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-005 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare costi e chiamate, così da ottenere un risultato ripetibile per «ottimizzare costi e chiamate» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-005 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio rafforzare osservabilità e diagnosi, così da ottenere un risultato ripetibile per «rafforzare osservabilità e diagnosi» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AUT-001 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere versioning, secret e dipendenze, così da ottenere un risultato ripetibile per «mantenere versioning, secret e dipendenze» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, DEV-021 | Sync success rate, Data loss incidents, Integration latency | P2 / H2 |
| `ACC-JTBD-INTEGRATION-DEV-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare sicurezza, scope e compatibilità, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-020 | Sync success rate, Data loss incidents, Integration latency | P0 / H1 |
| `ACC-JTBD-INTEGRATION-DEV-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare connector SDK e template, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | EVOLVE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-021 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P3 / H3 |
| `ACC-JTBD-INTEGRATION-DEV-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere MCP e app ecosystem di Accordo, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | DEV-001, DEV-002, DEV-007, AUT-011, DEV-010, AIA-021 | Sync success rate, Data loss incidents, Integration latency | P3 / H3 |

## Agentic CRM Platform Engineer / AI Automation Architect (`PER-AI-AGENT-ENG`)

**Missione:** Costruire agenti CRM affidabili che osservano, decidono e agiscono entro policy verificabili, con evaluation e rollback.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-AGENT-ENG-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio identificare processi candidati all'autonomia, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | CONFIGURE / L3 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, PLT-002 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire agent contract, outcome e non-goal, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | CONFIGURE / L3 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, PLT-002 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio progettare tool, permessi e contesto, così da decidere sulla base di effetto causale, guardrail e learning riutilizzabile. | CONFIGURE / L3 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, PLT-002 | Experiment velocity, Decision rate, Incremental lift | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio preparare dataset di valutazione e sandbox, così da ottenere un risultato ripetibile per «preparare dataset di valutazione e sandbox» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, PLT-002 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio implementare retrieval e memoria, così da ottenere un risultato ripetibile per «implementare retrieval e memoria» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio implementare planning e decomposizione, così da ottenere un risultato ripetibile per «implementare planning e decomposizione» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio collegare agenti a workflow e managed action, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EXECUTE / L2 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare human approval e exception inbox, così da ottenere un risultato ripetibile per «configurare human approval e exception inbox» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio applicare policy, guardrail e budget, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | EXECUTE / L2 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio orchestrare agenti specializzati, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EXECUTE / L2 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare task success, costi e latenza, così da ottenere un risultato ripetibile per «monitorare task success, costi e latenza» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AIA-002 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire failure, retry e compensazione, così da ottenere un risultato ripetibile per «gestire failure, retry e compensazione» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AUT-001 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare qualità tramite eval e feedback, così da ottenere un risultato ripetibile per «migliorare qualità tramite eval e feedback» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AIA-005 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare model routing e context, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | OPTIMIZE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AIA-005 | Routing accuracy, Median response time, SLA attainment | P1 / H1 |
| `ACC-JTBD-AGENT-ENG-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre hallucination e azioni non autorizzate, così da ottenere un risultato ripetibile per «ridurre hallucination e azioni non autorizzate» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AIA-005 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio aumentare autonomia entro policy, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | OPTIMIZE / L3 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, AIA-005 | Task success rate, Human override rate, Policy violation rate | P1 / H1 |
| `ACC-JTBD-AGENT-ENG-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere versioni, trace e regressioni, così da ottenere un risultato ripetibile per «mantenere versioni, trace e regressioni» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, DEV-010 | Task success rate, Policy violation rate, Human override rate | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare deploy, canary, rollback e audit, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, GOV-006 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-AGENT-ENG-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio abilitare evoluzione sicura di prompt, tool e workflow, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | MEDIUM | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, DEV-009 | Workflow success rate, Cycle time reduction, Manual touches avoided | P2 / H2 |
| `ACC-JTBD-AGENT-ENG-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio costruire capability pack e marketplace agentico, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | AIA-014, AIA-015, AIA-020, AIA-021, DEV-022, DEV-009 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |

## Data Governance, Privacy & Security Manager (`PER-GOV-DATA`)

**Missione:** Garantire che dati, automazioni e agenti siano usati secondo finalità, permessi, sicurezza e accountability dimostrabili.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-GOVERNANCE-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio inventariare dati, trattamenti e responsabili, così da ottenere un risultato ripetibile per «inventariare dati, trattamenti e responsabili» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, PLT-002 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio classificare PII, segreti e criticità, così da ottenere un risultato ripetibile per «classificare pii, segreti e criticità» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, PLT-002 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire policy di consenso e finalità, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | CONFIGURE / L3 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, PLT-002 | Policy violation rate, Access review completion, DSAR SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare accessi, SSO e segregation, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | CONFIGURE / L3 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, PLT-002 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire preferenze e lawful basis, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | EXECUTE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire DSAR, export e cancellazione, così da ottenere un risultato ripetibile per «gestire dsar, export e cancellazione» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L2 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Policy violation rate, Access review completion, DSAR SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio applicare retention e legal hold, così da ottenere un risultato ripetibile per «applicare retention e legal hold» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio eseguire access review e recertification, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | EXECUTE / L2 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare audit log e policy violation, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | MONITOR / L2 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-002 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio valutare connector e vendor risk, così da scambiare dati e azioni senza perdita, duplicazione o rottura dei contratti. | INVESTIGATE / L2 | LOW | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-007 | Sync success rate, P95 integration latency, Data loss/duplication incidents | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire data residency e encryption, così da ottenere un risultato ripetibile per «gestire data residency e encryption» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare incident response, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | EXECUTE / L3 | MEDIUM | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AUT-001 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre esposizione e data minimization, così da ottenere un risultato ripetibile per «ridurre esposizione e data minimization» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-005 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare evidence collection, così da ottenere un risultato ripetibile per «migliorare evidence collection» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-005 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio valutare rischio AI e autonomia, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | INVESTIGATE / L2 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-007 | Task success rate, Human override rate, Policy violation rate | P1 / H1 |
| `ACC-JTBD-GOVERNANCE-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio monitorare bias, fairness ed explainability, così da ottenere un risultato ripetibile per «monitorare bias, fairness ed explainability» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-002 | Policy violation rate, Access review completion, DSAR SLA | P2 / H2 |
| `ACC-JTBD-GOVERNANCE-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere policy-as-code e controlli, così da ottenere un risultato ripetibile per «mantenere policy-as-code e controlli» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, DEV-010 | Policy violation rate, Access review completion, DSAR SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare eccezioni, approvazioni e accountability, così da ottenere un risultato ripetibile per «governare eccezioni, approvazioni e accountability» con dati affidabili, responsabilità chiare e impatto misurabile. | GOVERN / L2 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-020 | Policy violation rate, Access review completion, DSAR SLA | P0 / H1 |
| `ACC-JTBD-GOVERNANCE-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio automatizzare compliance con guardian agent, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-GOVERNANCE-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere security e privacy architecture, così da rispettare finalità, preferenze e diritti dimostrando ogni decisione. | EVOLVE / L3 | HIGH | GOV-002, GOV-003, GOV-006, GOV-009, GOV-010, AIA-021 | Policy violation rate, Audit completeness, Access review SLA | P3 / H3 |

## Revenue Finance Analyst (`PER-FIN-REV`)

**Missione:** Riconciliare piano, pipeline, bookings, billing e ricavi per rendere affidabili le decisioni economiche del motore revenue.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-REV-FIN-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire ARR, MRR, bookings e revenue policy, così da ottenere un risultato ripetibile per «definire arr, mrr, bookings e revenue policy» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, PLT-002 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P0 / H1 |
| `ACC-JTBD-REV-FIN-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare CRM, billing, ERP e data warehouse, così da ottenere un risultato ripetibile per «collegare crm, billing, erp e data warehouse» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, PLT-002 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P2 / H2 |
| `ACC-JTBD-REV-FIN-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare piano, budget e scenari, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | CONFIGURE / L3 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, PLT-002 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-REV-FIN-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare riconciliazioni e control framework, così da ottenere un risultato ripetibile per «impostare riconciliazioni e control framework» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, PLT-002 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P2 / H2 |
| `ACC-JTBD-REV-FIN-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare bookings, ricavi e variazioni, così da ottenere un risultato ripetibile per «monitorare bookings, ricavi e variazioni» con dati affidabili, responsabilità chiare e impatto misurabile. | MONITOR / L2 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-002 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P1 / H1 |
| `ACC-JTBD-REV-FIN-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio riconciliare pipeline, forecast e fatturato, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | INVESTIGATE / L2 | MEDIUM | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-REV-FIN-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare renewal, churn e contraction, così da intervenire prima che il rischio si materializzi e rendere prevedibile la retention. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | Gross retention, Renewal forecast accuracy, At-risk ARR covered | P1 / H1 |
| `ACC-JTBD-REV-FIN-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio valutare pricing, sconti e margine, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | INVESTIGATE / L2 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-REV-FIN-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio calcolare CAC, LTV e payback, così da ottenere un risultato ripetibile per «calcolare cac, ltv e payback» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | CAC, LTV:CAC, Payback period | P2 / H2 |
| `ACC-JTBD-REV-FIN-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio analizzare customer e segment profitability, così da attivare solo soggetti eleggibili con definizione riproducibile, consenso valido e stima di reach. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | Eligible audience size, Match rate, Suppression accuracy | P2 / H2 |
| `ACC-JTBD-REV-FIN-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio monitorare budget e channel ROI, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | MONITOR / L2 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-002 | Budget variance, Incremental return, Pacing accuracy | P0 / H1 |
| `ACC-JTBD-REV-FIN-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio supportare commissioni e attainment, così da ottenere un risultato ripetibile per «supportare commissioni e attainment» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L2 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AUT-001 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P0 / H1 |
| `ACC-JTBD-REV-FIN-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare forecast accuracy e cash visibility, così da ridurre l'incertezza con stima, range, driver e confidenza riconciliabili. | OPTIMIZE / L3 | MEDIUM | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-005 | Forecast accuracy, Forecast bias, Coverage-to-target | P1 / H1 |
| `ACC-JTBD-REV-FIN-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare unit economics e mix, così da ottenere un risultato ripetibile per «ottimizzare unit economics e mix» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-005 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P2 / H2 |
| `ACC-JTBD-REV-FIN-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio identificare anomalie e leakage, così da identificare causa, impatto e rimedio prima che il problema si propaghi. | INVESTIGATE / L2 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-007 | Mean time to detect, Mean time to recover, Repeat incident rate | P2 / H2 |
| `ACC-JTBD-REV-FIN-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio simulare scenari di crescita e capacità, così da allocare risorse sul rendimento atteso più alto mantenendo vincoli e scenari espliciti. | DECIDE / L3 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-004 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P2 / H2 |
| `ACC-JTBD-REV-FIN-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere metriche, mapping e closing process, così da far sì che persone e agenti usino definizioni coerenti, riconciliate e tracciabili. | MAINTAIN / L3 | LOW | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, DEV-010 | Metric reconciliation variance, Dashboard adoption, Time to insight | P2 / H2 |
| `ACC-JTBD-REV-FIN-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare audit, riconciliazioni e accessi, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-REV-FIN-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio creare finance analyst agent con evidence trail, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-REV-FIN-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere planning integrato revenue, così da convertire gap e opportunità in incrementi testabili, dipendenze chiare e vantaggio differenziante. | EVOLVE / L3 | MEDIUM | FIN-001, FIN-005, FIN-008, FIN-009, AIA-001, AIA-021 | Forecast accuracy, Revenue reconciliation variance, Gross margin | P3 / H3 |

## Deal Desk / Commercial Operations Specialist (`PER-OPS-DEAL-DESK`)

**Missione:** Portare le richieste commerciali dalla configurazione alla firma rapidamente, proteggendo margine, policy e obblighi.

| ID | Fase | JTBD | Pattern / autonomia | Rischio | Capability core | KPI | Priorità |
|---|---|---|---|---|---|---|---|
| `ACC-JTBD-DEAL-DESK-001` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio definire intake, checklist e SLA, così da ottenere un risultato ripetibile per «definire intake, checklist e sla» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, PLT-002 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-002` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio configurare catalogo, pricing e approval matrix, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | CONFIGURE / L3 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, PLT-002 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-003` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio collegare CPQ, CRM, legal ed e-sign, così da ottenere un risultato ripetibile per «collegare cpq, crm, legal ed e-sign» con dati affidabili, responsabilità chiare e impatto misurabile. | CONFIGURE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, PLT-002 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-004` | ADOPT | Quando introduco Accordo in un nuovo processo, segmento o team e devo configurare il modo corretto di lavorare, voglio impostare policy per eccezioni e agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | CONFIGURE / L3 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, PLT-002 | Task success rate, Human override rate, Policy violation rate | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-005` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio validare completezza della richiesta, così da mantenere dati utilizzabili con owner, lineage, soglie e remediation verificabile. | EXECUTE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Data quality score, Duplicate rate, Freshness SLA | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-006` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio configurare prodotti, quantità e termini, così da ottenere un risultato ripetibile per «configurare prodotti, quantità e termini» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-007` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio calcolare prezzo, sconto e margine, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | INVESTIGATE / L2 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-007 | Gross margin, Approval turnaround, Discount leakage | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-008` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio instradare approvazioni, così da assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione. | EXECUTE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-009` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio generare quote e documenti, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | CREATE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-011 | Quote turnaround, Contract cycle time, Rework rate | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-010` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio coordinare review legale, security e finance, così da ottenere un risultato ripetibile per «coordinare review legale, security e finance» con dati affidabili, responsabilità chiare e impatto misurabile. | EXECUTE / L2 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-011` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio gestire redline, versioni e scadenze, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | EXECUTE / L2 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Quote turnaround, Contract cycle time, Rework rate | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-012` | RUN | Quando si verifica un evento operativo e devo portare a termine il lavoro con contesto completo, voglio portare contratto a firma e close, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | EXECUTE / L2 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AUT-001 | Quote turnaround, Contract cycle time, Rework rate | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-013` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ridurre turnaround e rework, così da ottenere un risultato ripetibile per «ridurre turnaround e rework» con dati affidabili, responsabilità chiare e impatto misurabile. | OPTIMIZE / L3 | LOW | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-005 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-014` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio ottimizzare sconti e protezione margine, così da accelerare la decisione commerciale senza erodere margine o oltrepassare le deleghe. | OPTIMIZE / L3 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-005 | Gross margin, Approval turnaround, Discount leakage | P1 / H1 |
| `ACC-JTBD-DEAL-DESK-015` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio identificare clausole e pattern di rischio, così da ottenere un risultato ripetibile per «identificare clausole e pattern di rischio» con dati affidabili, responsabilità chiare e impatto misurabile. | INVESTIGATE / L2 | LOW | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-007 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-016` | OPTIMIZE | Quando le performance sono sotto target o emerge un'opportunità di miglioramento, voglio migliorare handoff post-firma, così da ridurre il ciclo commerciale preservando obblighi, versioni, approvazioni e audit. | OPTIMIZE / L3 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-005 | Quote turnaround, Contract cycle time, Rework rate | P1 / H1 |
| `ACC-JTBD-DEAL-DESK-017` | MAINTAIN | Quando devo preservare qualità, continuità e affidabilità nel tempo, voglio mantenere catalogo, template e obblighi, così da ottenere un risultato ripetibile per «mantenere catalogo, template e obblighi» con dati affidabili, responsabilità chiare e impatto misurabile. | MAINTAIN / L3 | LOW | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, DEV-010 | Quote turnaround time, Approval SLA, Discount leakage | P2 / H2 |
| `ACC-JTBD-DEAL-DESK-018` | GOVERN | Quando la decisione può avere impatti economici, legali, reputazionali o sui dati, voglio governare eccezioni, audit e segregation, così da applicare il minimo privilegio e produrre evidenza verificabile di accessi e azioni. | GOVERN / L2 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-020 | Policy violation rate, Audit completeness, Access review SLA | P0 / H1 |
| `ACC-JTBD-DEAL-DESK-019` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio automatizzare review standard con agenti, così da aumentare autonomia e produttività senza perdere controllo, evidenze, costi e rollback. | EVOLVE / L3 | HIGH | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-021 | Task success rate, Human override rate, Policy violation rate | P1 / H2 |
| `ACC-JTBD-DEAL-DESK-020` | EVOLVE | Quando emerge un gap funzionale o un nuovo modo di generare valore con la piattaforma, voglio evolvere commercial workflow e contract intelligence, così da rendere il processo ripetibile, idempotente, osservabile e recuperabile. | EVOLVE / L3 | MEDIUM | SAL-015, SAL-016, SAL-017, FIN-003, FIN-011, AIA-021 | Workflow success rate, Cycle time reduction, Manual touches avoided | P2 / H2 |



---

<!-- SOURCE: docs/04_coverage_model.md -->

# 04 — Modello di coverage e protocollo di audit

## 1. Perché la copertura è multidimensionale

Un CRM può avere un oggetto `Opportunity` e non coprire il lavoro di forecasting; può avere un bottone “AI” e non avere evaluation, policy o audit. La coverage viene quindi misurata per dimensione:

1. `data_model`
2. `backend_service`
3. `workflow`
4. `agent`
5. `ui_ux`
6. `integration`
7. `security_governance`
8. `observability`
9. `tests`
10. `documentation`

Una dimensione può essere `N/A` solo con motivazione. L'assenza di UI, per esempio, non è `N/A` se il JTBD appartiene a un utente operativo.

## 2. Rubrica 0–4 per dimensione

| Score | Significato | Evidenza minima |
|---:|---|---|
| 0 | Assente | nessun artefatto invocabile |
| 1 | Concetto/stub | doc, TODO, mock, tipo o shell non collegata |
| 2 | Parziale | parte del flusso funziona; eccezioni, ruolo o output incompleti |
| 3 | Funzionale | percorso end-to-end, test happy e confini principali |
| 4 | Production-ready | failure, security, observability, regression, docs e SLO |

## 3. Status complessivo

- `ABSENT`: tutte le dimensioni core sono 0.
- `CONCEPT_ONLY`: nessuna dimensione core supera 1.
- `PARTIAL`: almeno una dimensione core è 2+, ma una capability o acceptance sostanziale manca.
- `FUNCTIONAL`: tutte le dimensioni applicabili core sono almeno 3; test happy, scope, missing data e audit passano.
- `PRODUCTION_READY`: tutte le dimensioni applicabili sono almeno 3, quelle critiche sono 4, e non esistono gap critici.
- `DEPRECATED`: esiste ma il percorso è marcato da rimuovere.
- `NOT_ASSESSED`: non verificato sullo SHA.

Lo status non è la media matematica: vale il **weakest critical link**. Un workflow con UI eccellente ma permission assente rimane `PARTIAL`.

## 4. Evidence policy

Ogni claim usa:

```json
{
  "kind": "CODE",
  "path": "src/domain/leads/service.ts",
  "symbol_or_line": "LeadService.qualify L80-L146",
  "claim": "La qualificazione modifica lo stage soltanto attraverso il service boundary",
  "test_result": "pnpm test lead-qualification — PASS"
}
```

Evidenze ammesse:

- `DATA_MODEL`: schema, migration, manifest, indice, constraint;
- `CODE`: service/domain implementation;
- `API`: route, command, schema, auth;
- `WORKFLOW`: trigger, action, transaction, retry;
- `AGENT`: contract, tool, prompt/version, policy, evaluation;
- `UI`: schermata realmente collegata;
- `TEST`: comando ed esito;
- `OBSERVABILITY`: metric, log, trace, alert;
- `SECURITY`: permission/policy e test negativo;
- `DOC`: runbook o contract, mai sufficiente da solo.

## 5. Audit order

1. Blocca lo SHA.
2. Valida catalogo.
3. Crea il file assessment con `init_coverage.py`.
4. Analizza capability core prima di quelle supporting.
5. Verifica i JTBD P0/P1 e ad alto rischio.
6. Esegui test e registra limiti di ambiente.
7. Deriva gap e next action.
8. Esegui `score_roadmap.py`.
9. Raggruppa per capability/epic, non per schermata.
10. Fai review umana dei casi con rischio HIGH o autonomia L3+.

## 6. Copertura a livello capability e a livello JTBD

La capability coverage risponde: “la piattaforma possiede questa capacità in modo generale?”  
La JTBD coverage risponde: “questa persona può completare questo lavoro in questo scenario?”

Una capability `FUNCTIONAL` può produrre un JTBD `PARTIAL` se:

- manca la vista o il permesso del ruolo;
- non copre il particolare journey o dato;
- il workflow non gestisce l'eccezione;
- il KPI non è osservabile;
- l'autonomia richiesta non ha guardrail/eval;
- l'integrazione necessaria non esiste.

## 7. Criteri di evidence confidence

| Confidence | Uso |
|---:|---|
| 0.2 | indizio o nome |
| 0.4 | codice letto ma non eseguito |
| 0.6 | percorso eseguito parzialmente |
| 0.8 | test riproducibile sullo SHA |
| 1.0 | test + produzione/telemetry verificata |

Lo status deve essere coerente con confidence. `PRODUCTION_READY` sotto 0.8 richiede motivazione eccezionale ed è normalmente invalido.

## 8. Audit dei casi agentici

Oltre alle dimensioni normali verificare:

- agent contract, goal e non-goal;
- tool allowlist e schema;
- autorizzazione ereditata;
- policy decision prima del tool call;
- prompt/model/tool version;
- retrieval con fonti;
- evaluation set e threshold;
- prompt injection e data exfiltration;
- cost/latency budget;
- retry, timeout e compensazione;
- human override e exception inbox;
- canary, rollback e regression.

## 9. Output atteso

Il file `coverage_jtbd.assessed.jsonl` deve mantenere esattamente un record per JTBD. Ogni gap deve essere testabile, per esempio:

**Debole:** “manca governance”.  
**Corretto:** “la route `POST /api/campaigns/:id/launch` non verifica `Consent.status` e il test di opt-out non esiste; aggiungere policy check al service boundary e test negativo”.

## 10. Gate finale

Un audit è completo quando:

- tutti i 600 JTBD hanno status diverso da `NOT_ASSESSED`, oppure esiste una lista esplicita di scope escluso;
- nessun evidence path è vuoto per status `PARTIAL+`;
- ogni P0 ha confidence almeno 0.6;
- ogni `FUNCTIONAL+` ha almeno un test;
- ogni HIGH risk ha security/governance evidence;
- ogni caso agentico ha eval evidence o rimane al massimo `PARTIAL`.



---

<!-- SOURCE: docs/05_roadmap_and_competition.md -->

# 05 — Da gap a roadmap e benchmark competitivo

## 1. Prima audit, poi roadmap

`NOT_ASSESSED` non significa “mancante”. La roadmap nasce solo da gap verificati sullo SHA. Le iniziative vengono raggruppate per capability e percorso end-to-end, evitando cento ticket che aggiungono campi o bottoni senza chiudere un lavoro.

## 2. Gap weight

| Coverage | Peso gap |
|---|---:|
| ABSENT | 1.00 |
| CONCEPT_ONLY | 0.85 |
| PARTIAL | 0.55 |
| FUNCTIONAL | 0.20 |
| PRODUCTION_READY | 0.00 |
| DEPRECATED | 1.00 se ancora richiesto |
| NOT_ASSESSED | nessuno score: audit prima |

## 3. Roadmap score

```text
Impact = AuditPriorityScore × GapWeight
RoadmapScore = Impact × DependencyReadiness / sqrt(EffortPoints)
```

`DependencyReadiness` è 0.5–1.0. Un requisito ad alto valore ma dipendente da identity, permission o event foundation non va implementato come eccezione locale: prima si chiude la capability abilitante.

## 4. Horizon

- `H1`: foundation, P0, rischio alto, lavori ad alta frequenza e gap che bloccano molti JTBD.
- `H2`: ottimizzazione, integrazioni, esperienza per ruolo e agenti L2/L3.
- `H3`: differenziazione avanzata, digital twin, multi-agent, marketplace e autonomia L4/L5.

## 5. Tassonomia epic consigliata

1. Tenant, schema e permission foundation
2. Customer identity e 360 timeline
3. Ingestion, quality, lineage e activation
4. Lead, routing e qualification
5. Account, opportunity e pipeline
6. Forecast, deal intelligence e commercial control
7. Audience, consent e lifecycle orchestration
8. Campaign execution, content e experimentation
9. Onboarding, health, renewal ed expansion
10. Case, knowledge, SLA e omnichannel service
11. Semantic layer, dashboard e decision intelligence
12. Workflow runtime, idempotency, outbox e rollback
13. Agent runtime, tool registry, evidence ed approval
14. Evaluation, policy, cost/latency e safe evolution
15. Developer platform, connector SDK e MCP ecosystem
16. Admin, release, observability e reliability
17. Privacy, security, audit e compliance
18. Finance, pricing, contract, partner economics

## 6. Definition of Ready dell'epic

- JTBD e persona con ID;
- evidence del gap sullo SHA;
- capability core;
- outcome/KPI;
- data entities e integration dependency;
- threat model e autonomy level;
- acceptance e non-functional requirements;
- rollout e rollback;
- effort e dependency map.

## 7. Benchmark competitivo

Il benchmark non è una checklist di feature marketing. Ogni competitor viene valutato per dominio/capability con:

- profondità funzionale;
- time-to-value;
- customer 360 e data freshness;
- orchestration e reliability;
- autonomia agentica reale;
- evidenze ed explainability;
- governance e permission;
- developer experience ed estensibilità;
- analytics e outcome measurement;
- TCO e complessità operativa.

Ogni score richiede `evidence_date`, fonte e confidence. Le feature dei vendor cambiano: il template contiene soltanto target di ricerca, non claim.

## 8. Strategie possibili

Per ogni capability scegliere una decisione:

- **PARITY:** necessaria per non essere esclusi.
- **DIFFERENTIATE:** Accordo può essere nettamente migliore.
- **INTEGRATE:** conviene delegare a un sistema specialista.
- **CONFIGURE:** capability generica risolta con manifest/workflow.
- **DEFER:** valore o readiness insufficienti.
- **IGNORE:** fuori ICP o contrario ai principi del prodotto.

## 9. Ipotesi di differenziazione da validare

1. Agent-first ma evidence-first: ogni decisione è spiegabile e verificabile.
2. Managed actions: l'agente non bypassa il dominio.
3. Evoluzione sicura: builder agent in sandbox, eval e promotion.
4. Un catalogo JTBD/capability nativo che collega prodotto, codice, test e roadmap.
5. Composability: data model, workflow, agent e connector pack versionabili.
6. Closed loop: ogni azione viene collegata all'outcome reale.

Sono ipotesi, non vantaggi acquisiti: diventano differenziazione soltanto con coverage `PRODUCTION_READY` e benchmark aggiornato.



---

<!-- SOURCE: docs/06_known_accordo_evidence_seed.md -->

# 06 — Known Accordo evidence seed da riverificare

## Avvertenza

Questa pagina raccoglie **claim provenienti da precedenti receipt di sviluppo condivise nella conversazione**, non da un audit attuale del repository. Non usarli per assegnare coverage senza aprire lo SHA target, localizzare il codice ed eseguire i test.

| Claim pregresso | Capability candidate | Status dichiarato nel receipt | Verifica richiesta |
|---|---|---|---|
| Il manifest distingue campi con `writable: managed` | `PLT-002`, `AUT-012` | implementato | trovare schema/manifest, parser e test |
| Create/update rifiutano un managed field al service boundary | `AUT-012`, `GOV-006` | implementato | trovare service validation e negative test da client |
| `applyManaged` è l'unico percorso di scrittura managed e non è esposto via HTTP | `AUT-012`, `AIA-015`, `DEV-001` | implementato | verificare call graph, route registry e permission |
| WorkflowEngine dispone di un confine transazionale esterno | `AUT-003`, `AUT-006` | implementato | verificare transazione, rollback e test multi-step |
| Gli eventi sono accodati tramite outbox prima della pubblicazione | `AUT-008`, `DEV-016` | implementato | verificare AsyncLocalStorage/outbox, commit order e failure test |
| È stata sviluppata una tranche di lead qualification senza CRUD bypass | `SAL-003`, `SAL-004` | tranche costruita | verificare UI/API/workflow, acceptance ed end-to-end test |

## Come usarli

1. Cercare il simbolo o l'implementazione sullo SHA.
2. Collegare path/linea al claim esatto.
3. Eseguire test esistente; se manca, lo status non supera `PARTIAL`.
4. Verificare che non esistano route o mutazioni alternative che bypassano il boundary.
5. Aggiornare `coverage_capabilities.assessed.jsonl` e i JTBD dipendenti.



---

<!-- SOURCE: docs/07_reference_architecture.md -->

# 07 — Reference architecture per un CRM intelligente e agentico

Questa non impone uno stack; definisce confini che l'audit deve riconoscere.

## Layer

1. **Experience layer** — workspace, inbox, dashboard, admin, mobile, portale.
2. **Agent layer** — agent contract, planner, retrieval, memory, model routing, eval.
3. **Orchestration layer** — trigger, workflow, approval, retry, transaction, outbox, scheduler.
4. **Domain service layer** — regole, managed action, permission, validation, state transition.
5. **Data/customer layer** — entity model, identity, timeline, consent, feature, lineage.
6. **Integration layer** — API, event, connector, MCP/tool, reverse ETL.
7. **Decision layer** — semantic metrics, score, forecast, experiment, evidence.
8. **Governance layer** — RBAC/ABAC, policy-as-code, DLP, audit, retention.
9. **Reliability layer** — log, metric, trace, SLO, replay, backup, incident.

## Regola del percorso di scrittura

```text
User/Agent
  -> authorized tool or command
  -> policy + permission check
  -> domain service / managed action
  -> transaction
  -> record state
  -> transactional outbox
  -> downstream event/action
  -> audit + trace + outcome telemetry
```

Nessuna UI, route, agent tool o integrazione deve scrivere direttamente lo stato saltando il service boundary.

## Evidence bundle di una decisione agentica

- tenant/user/service principal;
- goal e agent version;
- input record IDs e data freshness;
- retrieval source;
- model e prompt version;
- tool schema e arguments redatti;
- policy decision;
- confidence/uncertainty;
- approval o autonomy rule;
- result, side effect e idempotency key;
- cost/latency;
- outcome e feedback.

## Safe evolution loop

```text
gap/telemetry
 -> proposta di modifica
 -> sandbox branch/config
 -> synthetic + golden evaluation
 -> security/policy review
 -> human gate
 -> canary/feature flag
 -> observation
 -> promote or rollback
 -> catalog/coverage update
```

L'auto-evoluzione non modifica produzione in modo aperto. L'agente costruisce e valuta; la promotion rimane governata.



---

<!-- SOURCE: docs/08_epic_taxonomy.md -->

# 08 — Epic taxonomy e unità di delivery

## Anti-pattern

Una roadmap organizzata per “pagina Lead”, “pagina Account”, “aggiungi campo” o “AI button” tende a creare copertura nominale e percorsi rotti. L'unità consigliata è un **vertical slice di JTBD** che attraversa data, service, workflow, agent, UI, governance e test.

## Template epic

```yaml
epic_id: ACC-EPIC-...
title:
jtbd_ids: []
persona_ids: []
capability_ids: []
problem:
outcome:
current_evidence:
coverage_before:
scope:
non_goals:
data_model:
domain_rules:
workflow:
agent:
ui:
integrations:
security:
observability:
tests:
migration:
rollout:
rollback:
kpis:
coverage_target:
```

## Sequenza di delivery

1. Foundation e invariant.
2. Percorso read-only/evidence.
3. Human-in-the-loop.
4. Azione managed con transaction/outbox.
5. Failure e recovery.
6. Role UX.
7. Telemetry e outcome.
8. Autonomia superiore soltanto dopo eval.

## Tranche consigliata

Una tranche dovrebbe chiudere 1–5 JTBD molto correlati o una capability abilitante. Deve lasciare il repository in uno stato coerente, testato e distribuibile; non può introdurre un bypass temporaneo.



---

<!-- SOURCE: docs/09_end_to_end_scenarios.md -->

# 09 — Scenari end-to-end di simulazione

Gli scenari collegano più cappelli e JTBD. Sono pensati come fixture di acceptance, demo e regression suite.

## ACC-E2E-001 — Adozione iniziale di Accordo in una SaaS B2B

**Scopo:** Validare configurazione, migrazione, governance, integrazioni, training e go-live senza bypass.  
**Stato iniziale:** Tenant vuoto; dati storici in CRM legacy, marketing automation, billing e warehouse; policy e lifecycle non uniformi.  

**Ruoli:** `PER-PROD-CRM-PO`, `PER-PLAT-ADMIN`, `PER-OPS-REVOPS`, `PER-DATA-ENG`, `PER-GOV-DATA`, `PER-SALES-ENABLE`  

**JTBD coinvolti:** 30; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Definizione outcome, lifecycle e source of truth.
2. Inventario fonti e data contract.
3. Configurazione tenant, entità, ruoli e managed field.
4. Import dry-run con deduplica e identity matching.
5. Collegamento integrazioni in sandbox.
6. Test end-to-end, negative authorization e rollback.
7. Training per ruolo, pilot, canary e go-live.

### Failure injection
- Campo managed presente nel file import
- Due record con identità ambigua
- Credenziale connector scaduta
- Utente Sales tenta export fuori scope

### Outcome attesi
- Go-live versionato e reversibile
- Nessun bypass di managed field
- Identity collision in exception queue
- Evidence pack e adoption telemetry

### Exit criteria
- Tutte le acceptance P0 del rollout passano
- Zero write non auditabile
- Runbook e rollback provati
- Owner e SLO definiti

## ACC-E2E-002 — Inbound demand: da campagna a opportunità accettata

**Scopo:** Validare audience/consenso, lead capture, scoring, routing, SLA, sequence, qualificazione e handoff.  
**Stato iniziale:** Campagna approvata; audience con consensi misti; territori e SLA configurati.  

**Ruoli:** `PER-EXEC-MKT-DIR`, `PER-OPS-MKT-OPS`, `PER-MKT-PERF`, `PER-MKT-CAMPAIGN`, `PER-SALES-SDR`, `PER-SALES-AE`, `PER-SALES-MGR`  

**JTBD coinvolti:** 37; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Ingresso form e offline conversion
2. Stitch con profilo esistente
3. Scoring fit/intent
4. Routing al corretto SDR
5. Sequence e risposta
6. Qualificazione e meeting
7. Handoff accettato dall'AE

### Failure injection
- Contatto opt-out nel segmento
- Lead duplicato con owner esistente
- Routing service timeout
- Risposta positiva classificata con bassa confidence

### Outcome attesi
- Opt-out soppresso
- Un solo owner
- Retry idempotente
- Caso ambiguo portato a review
- Attribution closed-loop

### Exit criteria
- SLA misurato end-to-end
- Nessuna duplicazione di attività
- Qualification reason versionata
- Handoff con contesto completo

## ACC-E2E-003 — ABM enterprise e buying committee orchestration

**Scopo:** Validare account tiering, intent, relationship graph, personalizzazione, seller alert e pipeline influence.  
**Stato iniziale:** Lista target account, enrichment e segnali intent; coverage buying committee incompleta.  

**Ruoli:** `PER-MKT-ABM`, `PER-SALES-AE`, `PER-MKT-PMM`, `PER-MKT-CONTENT`, `PER-SALES-MGR`  

**JTBD coinvolti:** 38; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Tiering account
2. Relationship mapping
3. Generazione value hypothesis
4. Orchestration ads/content/seller touch
5. Intent surge alert
6. Meeting e opportunity
7. Influence measurement

### Failure injection
- Intent provider in ritardo
- Persona non consentita al contatto
- Account ownership contestata
- Claim competitivo senza fonte

### Outcome attesi
- Confidence e freshness visibili
- Contatto bloccato se non eleggibile
- Ownership risolta prima dell'azione
- Claim non pubblicato senza approvazione

### Exit criteria
- Buying committee coverage misurata
- Ogni touch collegato a account e play
- Seller alert con evidenze
- Pipeline influence non duplicata

## ACC-E2E-004 — Closed-won, onboarding, value realization, renewal ed expansion

**Scopo:** Validare handoff, success plan, product usage, health, risk play, QBR, renewal e expansion.  
**Stato iniziale:** Contratto firmato; obiettivi e stakeholder nel deal; telemetry prodotto e billing collegati.  

**Ruoli:** `PER-SALES-AE`, `PER-CUST-CVM`, `PER-EXEC-CS-DIR`, `PER-FIN-REV`, `PER-EXEC-CRO`  

**JTBD coinvolti:** 43; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Handoff accettato
2. Success plan e milestone
3. Primo valore
4. Calo di adozione
5. Risk play
6. QBR con ROI
7. Renewal forecast
8. Expansion proposta

### Failure injection
- Contratto senza entitlement mappato
- Usage event stale
- Champion cambia azienda
- Sconto renewal fuori delega

### Outcome attesi
- Task di remediation con owner
- Health segnala freshness
- Stakeholder risk esplicito
- Deal desk approval per eccezione

### Exit criteria
- Time-to-value misurato
- Risk play collegato all'esito
- Forecast riconciliato al billing
- Expansion basata su valore

## ACC-E2E-005 — Customer service incident e comunicazione proattiva

**Scopo:** Validare identity, triage, knowledge, SLA, escalation, incident, self-service e feedback loop.  
**Stato iniziale:** Picco di casi legati a una regressione prodotto; knowledge non ancora aggiornata.  

**Ruoli:** `PER-EXEC-CUST-OPS`, `PER-SVC-AGENT`, `PER-CUST-CVM`, `PER-GOV-DATA`  

**JTBD coinvolti:** 38; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Rilevazione anomalia
2. Case clustering
3. Triage e autenticazione
4. Swarming engineering/customer
5. Comunicazione proattiva
6. Risoluzione e knowledge update
7. Post-incident review

### Failure injection
- Articolo KB obsoleto
- Cliente non autenticato chiede azione sensibile
- SLA prossimo alla scadenza
- Canale email non disponibile

### Outcome attesi
- Risposta non allucinata
- Azione sensibile bloccata
- Escalation con contesto
- Fallback di canale e audit

### Exit criteria
- FCR/CSAT misurati
- Incidenti correlati
- Knowledge versionata
- Root cause e prevention task

## ACC-E2E-006 — Data quality, identity e lineage incident

**Scopo:** Validare duplicate detection, identity split/merge, freshness, lineage, downstream impact e remediation.  
**Stato iniziale:** Una modifica schema upstream crea duplicati e rompe la freshness di più metriche e audience.  

**Ruoli:** `PER-DATA-ENG`, `PER-PLAT-ADMIN`, `PER-OPS-REVOPS`, `PER-DATA-ANALYTICS`, `PER-GOV-DATA`  

**JTBD coinvolti:** 34; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Alert schema/freshness
2. Impact analysis via lineage
3. Stop activation
4. Golden set identity review
5. Backfill e split/merge
6. Metric reconciliation
7. Postmortem

### Failure injection
- Eventi fuori ordine
- False merge VIP
- Backfill parziale
- Dashboard cache non invalidata

### Outcome attesi
- Activation pausata
- Merge reversibile
- Replay idempotente
- Metriche riconciliate e invalidate correttamente

### Exit criteria
- Nessuna perdita dati
- Lineage completo
- False merge misurato
- Runbook aggiornato

## ACC-E2E-007 — Safe evolution di un agente CRM

**Scopo:** Validare discovery, agent contract, tool permission, eval, sandbox, canary, rollback e coverage update.  
**Stato iniziale:** Agente L2 prepara follow-up ma il team vuole permettere l'invio L4 entro policy.  

**Ruoli:** `PER-AI-AGENT-ENG`, `PER-PROD-CRM-PO`, `PER-PLAT-ADMIN`, `PER-GOV-DATA`, `PER-DEV-INTEGRATION`  

**JTBD coinvolti:** 50; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Threat model
2. Tool contract
3. Golden eval set
4. Prompt/tool version
5. Sandbox run
6. Red-team
7. Human gate
8. 1% canary
9. Outcome monitor
10. Promote/rollback

### Failure injection
- Prompt injection nel thread email
- Tool prova a scrivere managed field via CRUD
- Costo supera budget
- Provider model degrada

### Outcome attesi
- Injection isolata
- CRUD bypass bloccato
- Budget breaker attivato
- Rollback a modello/versione stabile

### Exit criteria
- Eval threshold superato
- Zero policy violation critica
- Override misurato
- Coverage e catalog evidence aggiornati

## ACC-E2E-008 — Revenue forecast e board review

**Scopo:** Validare semantic layer, pipeline, marketing contribution, renewal, finance reconciliation e scenario decision.  
**Stato iniziale:** Mese in corso sotto piano; Sales, Marketing e Finance usano numeri parzialmente diversi.  

**Ruoli:** `PER-EXEC-CRO`, `PER-EXEC-SALES-DIR`, `PER-OPS-REVOPS`, `PER-FIN-REV`, `PER-EXEC-MKT-DIR`, `PER-EXEC-CS-DIR`, `PER-DATA-ANALYTICS`  

**JTBD coinvolti:** 66; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Metric certification
2. Pipeline snapshot
3. Forecast by motion
4. Renewal risk
5. Marketing contribution
6. Finance reconciliation
7. Scenario reallocation
8. Decision log

### Failure injection
- Definizione ARR divergente
- Stage inflated
- Attribution duplicate
- Billing close incomplete

### Outcome attesi
- Metriche divergenti bloccate
- Forecast con confidence
- Double count rimosso
- Scenario espone assunzioni e range

### Exit criteria
- Bridge al piano
- Decisioni con owner
- Consuntivo successivo confrontabile
- Nessuna cifra senza lineage

## ACC-E2E-009 — Enterprise deal con eccezioni commerciali

**Scopo:** Validare opportunity, CPQ, sconto, margin guardrail, legal/security review, e-sign e handoff.  
**Stato iniziale:** Deal enterprise multi-product con sconto e clausole non standard.  

**Ruoli:** `PER-SALES-AE`, `PER-SALES-MGR`, `PER-OPS-DEAL-DESK`, `PER-FIN-REV`, `PER-GOV-DATA`  

**JTBD coinvolti:** 44; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Intake
2. Configuration
3. Margin calculation
4. Approval routing
5. Security/legal review
6. Redline
7. Signature
8. Handoff obligations

### Failure injection
- Catalog version mismatch
- Approver in conflitto di interesse
- Clause unsupported by playbook
- E-sign callback duplicato

### Outcome attesi
- Quote riproducibile
- Segregation enforced
- Clause escalata
- Callback idempotente

### Exit criteria
- Turnaround e rework misurati
- Obblighi trasferiti
- Audit completo
- Nessun sconto fuori delega

## ACC-E2E-010 — Partner co-sell e deal registration

**Scopo:** Validare onboarding partner, access segregation, account mapping, deal conflict, co-marketing, forecast e incentivi.  
**Stato iniziale:** Nuovo partner certificato registra un deal su account già lavorato dal direct sales.  

**Ruoli:** `PER-CHANNEL-MGR`, `PER-SALES-AE`, `PER-EXEC-SALES-DIR`, `PER-FIN-REV`, `PER-GOV-DATA`  

**JTBD coinvolti:** 35; elenco completo in `data/e2e_scenarios.json`.

### Eventi
1. Partner onboarding
2. Account mapping
3. Deal registration
4. Conflict resolution
5. Co-sell plan
6. Campaign
7. Forecast
8. Incentive calculation

### Failure injection
- Partner vede record di altro partner
- Account match ambiguo
- MDF spesa non documentata
- Deal duplicato

### Outcome attesi
- Tenant/partner scope preservato
- Exception queue per match
- MDF bloccato senza prova
- Unica opportunity canonica

### Exit criteria
- Registration SLA
- Ownership decision log
- Partner pipeline riconciliata
- Incentivo auditabile

