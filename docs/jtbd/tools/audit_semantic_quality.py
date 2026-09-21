#!/usr/bin/env python3
"""Deterministic semantic-quality detectors over the desired-state JTBD catalogue.

READ-ONLY. This script never writes to `docs/jtbd/catalog/*`; the catalogue is
frozen desired state and only a human may change a record.

It streams `catalog/jtbd.jsonl` line by line (the file is 4.6 MB) and emits
candidate findings. Every detector is a rule a reader can re-run and argue with.
An LLM may *confirm* a candidate by reading the record; no detector here is an
LLM.

Usage:
    python docs/jtbd/tools/audit_semantic_quality.py            # summary table
    python docs/jtbd/tools/audit_semantic_quality.py --json     # findings JSON
    python docs/jtbd/tools/audit_semantic_quality.py --sweep    # threshold sweep
    python docs/jtbd/tools/audit_semantic_quality.py --detector NEAR_DUPLICATE_JOB
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JTBD = ROOT / "catalog" / "jtbd.jsonl"
CAPS = ROOT / "catalog" / "capabilities.json"

# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------

# Italian function words. Removed before similarity so that "gestire i rinnovi"
# and "gestire rinnovi" are one job, not two.
STOPWORDS = {
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "l", "dell", "della",
    "delle", "dei", "degli", "del", "di", "da", "dal", "dalla", "dalle", "dai",
    "a", "al", "allo", "alla", "alle", "ai", "agli", "in", "nel", "nella",
    "nelle", "nei", "negli", "con", "col", "su", "sul", "sulla", "sulle", "sui",
    "per", "tra", "fra", "e", "ed", "o", "od", "che", "chi", "cui", "non",
    "come", "piu", "meno", "anche", "se", "si", "ne", "ci", "vi", "the", "of",
    "and", "to",
}

PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
WS = re.compile(r"\s+")


def fold(text: str) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return WS.sub(" ", PUNCT.sub(" ", text)).strip()


def content_tokens(text: str) -> frozenset:
    """Folded tokens with function words and 1-2 char noise removed."""
    return frozenset(
        t for t in fold(text).split() if t not in STOPWORDS and len(t) > 2
    )


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# --------------------------------------------------------------------------
# Lexicons
# --------------------------------------------------------------------------

# Words that name a screen, control, module, file format or technology rather
# than an outcome somebody wants. Word-boundary matched against the folded
# job_name and job_statement.want.
SOLUTION_TERMS = {
    "dashboard", "cruscotto", "schermata", "pagina", "pulsante", "bottone",
    "modulo", "moduli", "scheda", "tab", "form", "campo", "campi", "widget",
    "pannello", "menu", "sidebar", "popup", "tooltip", "toggle", "checkbox",
    "dropdown", "wizard", "api", "webhook", "endpoint", "csv", "excel", "sql",
    "json", "xml", "sdk", "cli", "ui", "gui", "database", "tabella", "query",
    "plugin", "connettore", "integrazione", "report", "reportistica",
}

# Verbs describing a single UI interaction rather than a job.
GRANULAR_TERMS = {
    "cliccare", "clicca", "click", "selezionare", "seleziona", "spuntare",
    "compilare", "compila", "digitare", "digita", "aprire", "apri", "chiudere",
    "salvare", "salva", "inserire", "inserisci", "scaricare", "scarica",
    "caricare", "carica", "esportare", "esporta", "importare", "importa",
    "filtrare", "filtra", "ordinare", "ordina", "copiare", "incollare",
    "scorrere", "premere", "trascinare",
}

# Italian infinitive endings. Used to count verbs in a job name.
INFINITIVE = re.compile(r"\w{3,}(are|ere|ire|arsi|ersi|irsi)$")

# Coordination markers that can join two separate jobs into one row.
COORD = re.compile(r"\s+(?:e|ed|poi|nonche|oppure)\s+|\s*[,/;]\s*")

# Concept -> competing surface terms. A concept whose variants are all in
# meaningful use is a vocabulary split, not a synonym choice.
CONCEPT_SYNONYMS = {
    "opportunity": ["opportunita", "trattativa", "deal", "affare"],
    "customer": ["cliente", "account", "customer"],
    "lead": ["lead", "prospect", "contatto potenziale"],
    "forecast": ["forecast", "previsione", "previsioni"],
    "revenue": ["revenue", "ricavo", "ricavi", "fatturato"],
    "renewal": ["rinnovo", "rinnovi", "renewal"],
    "approval": ["approvazione", "autorizzazione", "gate"],
    "churn": ["churn", "abbandono", "disdetta"],
    "onboarding": ["onboarding", "attivazione", "avvio"],
    "playbook": ["playbook", "manuale operativo", "runbook"],
    "pipeline": ["pipeline", "funnel", "imbuto"],
    "handover": ["handover", "passaggio di consegne", "consegna"],
}

# Default near-duplicate threshold. Justified by --sweep: see the report.
NEAR_DUP_THRESHOLD = 0.60

# Fields compared to decide whether two same-named jobs are distinguished by
# anything other than the role label.
DISTINGUISHING_FIELDS = (
    "trigger", "when", "so_that", "primary_flow", "outputs",
    "acceptance_criteria", "kpis",
)


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------

def stream_records(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_projection(path: Path):
    """Stream the corpus once, keeping only the small fields the detectors use."""
    rows = []
    for r in stream_records(path):
        js, uc, ad = r["job_statement"], r["use_case"], r["agentic_design"]
        rows.append({
            "id": r["jtbd_id"],
            "persona": r["persona_id"],
            "role": r["role"],
            "role_group": r.get("role_group", ""),
            "lifecycle": r["platform_lifecycle"],
            "pattern": ad["pattern"],
            "autonomy": ad["target_autonomy"],
            "autonomy_scale": ad.get("autonomy_scale", {}),
            "approval": bool(ad["human_approval_required"]),
            "job_name": r["job_name"],
            "when": js["when"],
            "want": js["want"],
            "so_that": js["so_that"],
            "trigger": uc["trigger"],
            "preconditions": tuple(uc.get("preconditions", [])),
            "tools": tuple(ad.get("tools_required", [])),
            "primary_flow": tuple(uc["primary_flow"]),
            "outputs": tuple(uc["outputs"]),
            "acceptance_criteria": tuple(r["acceptance_criteria"]),
            "kpis": tuple(r["kpis"]),
            "risk": r["risk_and_governance"]["risk_level"],
            "core": tuple(r["capabilities"]["core"]),
            "supporting": tuple(r["capabilities"]["supporting"]),
            "tokens": content_tokens(r["job_name"]),
            "folded": fold(r["job_name"]),
        })
    return rows


def finding(ftype, ids, evidence, disposition, proved, note=""):
    return {
        "findingType": ftype,
        "jtbdId": ids if isinstance(ids, str) else None,
        "jtbdIds": None if isinstance(ids, str) else list(ids),
        "evidence": evidence,
        "recommendedDisposition": disposition,
        "reviewStatus": "unreviewed",
        "basis": "proved" if proved else "suspected",
        "note": note,
    }


# --------------------------------------------------------------------------
# Detectors
# --------------------------------------------------------------------------

def d_solution_phrasing(rows):
    out = []
    for r in rows:
        hits = sorted(set(fold(r["job_name"] + " " + r["want"]).split()) & SOLUTION_TERMS)
        if hits:
            out.append(finding(
                "SOLUTION_PHRASING", r["id"],
                f'job_name="{r["job_name"]}" | solution term(s): {", ".join(hits)}',
                "REPHRASE_AS_OUTCOME", proved=False,
                note="Lexicon hit; a human must judge whether the term names the "
                     "outcome or the artefact.",
            ))
    return out


def d_granular_task(rows):
    out = []
    for r in rows:
        hits = sorted(set(fold(r["job_name"]).split()) & GRANULAR_TERMS)
        if hits:
            out.append(finding(
                "GRANULAR_UI_TASK", r["id"],
                f'job_name="{r["job_name"]}" | interaction verb(s): {", ".join(hits)}',
                "MERGE_INTO_PARENT_JOB", proved=False,
            ))
    return out


def d_compound_job(rows):
    out = []
    for r in rows:
        units = [u for u in COORD.split(fold(r["job_name"])) if u.strip()]
        verbs = [t for u in units for t in u.split() if INFINITIVE.match(t)]
        if len(units) >= 3 or len(verbs) >= 2:
            out.append(finding(
                "COMPOUND_JOB", r["id"],
                f'job_name="{r["job_name"]}" | {len(units)} coordinated unit(s), '
                f'{len(verbs)} infinitive verb(s)',
                "SPLIT_INTO_SEPARATE_JOBS",
                proved=len(verbs) >= 2,
                note="Two infinitives = two jobs in one row (proved by parse); "
                     "three or more coordinated objects is a candidate only.",
            ))
    return out


def d_tautological_outcome(rows):
    out = []
    for r in rows:
        want = fold(r["want"]).rstrip(" .")
        if want and want in fold(r["so_that"]):
            out.append(finding(
                "TAUTOLOGICAL_OUTCOME", r["id"],
                f'want="{r["want"]}" reappears verbatim inside '
                f'so_that="{r["so_that"][:120]}..."',
                "REWRITE_SO_THAT_AS_INDEPENDENT_OUTCOME", proved=True,
                note="The benefit clause restates the wanted action, so the row "
                     "states no outcome that could fail independently.",
            ))
    return out


def d_exact_duplicate(rows):
    by_name = defaultdict(list)
    for r in rows:
        by_name[r["folded"]].append(r)
    out = []
    for name, group in sorted(by_name.items()):
        if len(group) < 2:
            continue
        same = [f for f in DISTINGUISHING_FIELDS
                if len({tuple(g[f]) if isinstance(g[f], (list, tuple)) else g[f]
                        for g in group}) == 1]
        cross_role = len({g["persona"] for g in group}) > 1
        ftype = "CROSS_ROLE_DUPLICATE" if cross_role else "DUPLICATE_JOB"
        out.append(finding(
            ftype, [g["id"] for g in group],
            f'identical normalised job_name="{name}" across roles '
            f'{sorted({g["role"] for g in group})}; identical also in: '
            f'{", ".join(same) if same else "(none)"}',
            "MERGE_OR_DIFFERENTIATE_WITH_ROLE_SPECIFIC_TRIGGER", proved=True,
        ))
    return out


def d_near_duplicate(rows, threshold=NEAR_DUP_THRESHOLD):
    """Token-set Jaccard over folded, stopword-stripped job_name tokens.

    Deterministic and explainable: the evidence quotes both names and the
    shared token set, so a reader can recompute the score by hand.
    """
    out = []
    for a, b in combinations(rows, 2):
        if a["folded"] == b["folded"]:
            continue  # already reported as an exact duplicate
        s = jaccard(a["tokens"], b["tokens"])
        if s >= threshold:
            shared = sorted(a["tokens"] & b["tokens"])
            out.append(finding(
                "NEAR_DUPLICATE_JOB", [a["id"], b["id"]],
                f'"{a["job_name"]}" ({a["role"]}) vs "{b["job_name"]}" '
                f'({b["role"]}) | Jaccard={s:.2f} shared={shared}',
                "MERGE_OR_DIFFERENTIATE_WITH_ROLE_SPECIFIC_TRIGGER",
                proved=False,
                note=f"Lexical similarity only, threshold {threshold}. "
                     "Semantic sameness needs a human read.",
            ))
    out.sort(key=lambda f: f["evidence"], reverse=True)
    return out


def d_autonomy_contradiction(rows):
    out = []
    for r in rows:
        l3 = r["autonomy_scale"].get("L3", "")
        if r["autonomy"] == "L3" and not r["approval"] and "approvazione" in fold(l3):
            ac = next((c for c in r["acceptance_criteria"] if "L3" in c), "")
            out.append(finding(
                "CONTRADICTORY_JOB", r["id"],
                f'target_autonomy="L3" (defined in-record as "{l3}") with '
                f'human_approval_required=false; acceptance criterion still '
                f'reads "{ac[:90]}..."',
                "SET_APPROVAL_TRUE_OR_DOWNGRADE_AUTONOMY", proved=True,
                note="The record contradicts its own embedded autonomy scale and "
                     "its own acceptance criterion.",
            ))
    return out


def d_templated_context(rows):
    """`when` and `trigger` carry no role-specific information."""
    by_lc = defaultdict(set)
    by_pattern = defaultdict(set)
    for r in rows:
        by_lc[r["lifecycle"]].add(r["when"])
        by_pattern[r["pattern"]].add(r["primary_flow"])
    when_is_fn = all(len(v) == 1 for v in by_lc.values())
    flow_is_fn = all(len(v) == 1 for v in by_pattern.values())
    out = []
    if when_is_fn:
        out.append(finding(
            "ROLE_TRIGGER_INCOHERENCE", "CORPUS",
            f'{len({r["when"] for r in rows})} distinct job_statement.when '
            f'values across {len(rows)} records, one per platform_lifecycle '
            f'({sorted(by_lc)}); e.g. all {len([r for r in rows if r["lifecycle"] == "RUN"])} '
            f'RUN records share "{sorted(by_lc["RUN"])[0][:70]}..."',
            "AUTHOR_ROLE_SPECIFIC_TRIGGERS", proved=True,
            note="The situational clause is a pure function of lifecycle, so no "
                 "record's trigger distinguishes the role that holds it.",
        ))
    if flow_is_fn:
        out.append(finding(
            "ROLE_TRIGGER_INCOHERENCE", "CORPUS",
            f'{len({r["primary_flow"] for r in rows})} distinct '
            f'use_case.primary_flow blocks across {len(rows)} records, one per '
            f'agentic_design.pattern ({sorted(by_pattern)})',
            "AUTHOR_JOB_SPECIFIC_FLOWS", proved=True,
            note="The primary flow is a pure function of the agentic pattern, so "
                 "it is not testable evidence about any individual job.",
        ))
    return out


def d_conflicting_terms(rows):
    corpus = [fold(" ".join([r["job_name"], r["want"], r["so_that"],
                             " ".join(r["outputs"]), " ".join(r["kpis"])]))
              for r in rows]
    out = []
    for concept, variants in sorted(CONCEPT_SYNONYMS.items()):
        counts = {}
        for v in variants:
            pat = re.compile(r"\b" + re.escape(v) + r"\b")
            counts[v] = sum(1 for c in corpus if pat.search(c))
        live = {v: c for v, c in counts.items() if c > 0}
        if len(live) >= 2 and sorted(live.values())[-2] >= 5:
            out.append(finding(
                "CONFLICTING_TERMS", "CORPUS",
                f'concept "{concept}" written as ' +
                ", ".join(f'"{v}" in {c} records' for v, c in
                          sorted(live.items(), key=lambda kv: -kv[1])),
                "PICK_ONE_TERM_AND_DEFINE_IT_IN_A_GLOSSARY", proved=True,
                note="Second-most-used variant appears in at least 5 records, so "
                     "this is a split vocabulary, not an incidental synonym.",
            ))
    return out


def d_capability_gaps(rows):
    catalogue = json.loads(CAPS.read_text(encoding="utf-8"))
    all_ids = {c["capability_id"]: c for c in catalogue}
    core = Counter()
    supporting = Counter()
    for r in rows:
        core.update(r["core"])
        supporting.update(r["supporting"])
    referenced = set(core) | set(supporting)
    out = []
    for cid in sorted(set(all_ids) - referenced):
        c = all_ids[cid]
        out.append(finding(
            "UNREFERENCED_CAPABILITY", cid,
            f'{cid} "{c["name"]}" ({c["domain"]}) referenced by 0 of '
            f'{len(rows)} jobs, as neither core nor supporting',
            "ADD_A_JOB_THAT_NEEDS_IT_OR_RETIRE_THE_CAPABILITY", proved=True,
        ))
    for cid in sorted(set(supporting) - set(core)):
        c = all_ids[cid]
        out.append(finding(
            "MISSING_DEPENDENCY", cid,
            f'{cid} "{c["name"]}" appears as supporting in '
            f'{supporting[cid]} job(s) but is core to none: no job in the '
            f'catalogue owns producing it',
            "ADD_AN_OWNING_JOB_OR_DEMOTE_THE_DEPENDENCY", proved=True,
            note="A dependency every job leans on and no job owns is an "
                 "unowned prerequisite.",
        ))
    return out


def d_unowned_prerequisite(rows):
    """A precondition or tool every job assumes, that no job owns building.

    Each entry maps a literal precondition/tool string to the catalogue
    capability that would deliver it. The finding fires only when that
    capability is core to zero jobs, i.e. nobody in the catalogue is
    accountable for the thing every job stands on.
    """
    catalogue = json.loads(CAPS.read_text(encoding="utf-8"))
    all_ids = {c["capability_id"]: c for c in catalogue}
    core = Counter()
    referenced = set()
    for r in rows:
        core.update(r["core"])
        referenced.update(r["core"])
        referenced.update(r["supporting"])

    assumptions = [
        ("precondition", "Utente autenticato con ruolo e record scope validi.", "GOV-001"),
        ("tool", "Approval inbox", "AIA-019"),
        ("tool", "Workflow/action engine", "AUT-003"),
        ("precondition", "Definizioni, policy e owner del processo sono versionati.", "DEV-018"),
    ]
    out = []
    for kind, text, cid in assumptions:
        if cid not in all_ids:
            continue
        holders = sum(
            1 for r in rows
            if text in (r["preconditions"] if kind == "precondition"
                        else r["tools"])
        )
        if holders == 0 or core[cid] > 0:
            continue
        state = "referenced by no job at all" if cid not in referenced \
            else "listed only as a supporting capability"
        out.append(finding(
            "UNOWNED_PREREQUISITE", cid,
            f'{holders} of {len(rows)} records assume the {kind} '
            f'"{text}", but {cid} "{all_ids[cid]["name"]}" is core to 0 jobs '
            f'({state})',
            "ADD_AN_OWNING_JOB_FOR_THE_PREREQUISITE", proved=True,
            note="Every job depends on it and no job delivers it, so the "
                 "catalogue cannot be built in its own stated order.",
        ))
    return out


DETECTORS = {
    "UNOWNED_PREREQUISITE": d_unowned_prerequisite,
    "SOLUTION_PHRASING": d_solution_phrasing,
    "GRANULAR_UI_TASK": d_granular_task,
    "COMPOUND_JOB": d_compound_job,
    "TAUTOLOGICAL_OUTCOME": d_tautological_outcome,
    "DUPLICATE_JOB": d_exact_duplicate,
    "NEAR_DUPLICATE_JOB": d_near_duplicate,
    "CONTRADICTORY_JOB": d_autonomy_contradiction,
    "ROLE_TRIGGER_INCOHERENCE": d_templated_context,
    "CONFLICTING_TERMS": d_conflicting_terms,
    "CAPABILITY_GAPS": d_capability_gaps,
}


def sweep(rows):
    """Sensitivity of the near-duplicate detector to its threshold."""
    pairs = []
    for a, b in combinations(rows, 2):
        if a["folded"] == b["folded"]:
            continue
        s = jaccard(a["tokens"], b["tokens"])
        if s > 0:
            pairs.append(s)
    print(f"scored pairs with similarity > 0: {len(pairs)} "
          f"(of {len(rows) * (len(rows) - 1) // 2} total pairs)")
    print(f"{'threshold':>10} {'pairs >= t':>12}")
    for t in (0.90, 0.80, 0.75, 0.70, 0.667, 0.60, 0.50, 0.40, 0.34):
        print(f"{t:>10.3f} {sum(1 for s in pairs if s >= t):>12}")


def stats(rows):
    """Corpus-level template statistics. Every number in the report comes here."""
    caps = json.loads(CAPS.read_text(encoding="utf-8"))
    core, sup = Counter(), Counter()
    for r in rows:
        core.update(r["core"])
        sup.update(r["supporting"])
    def d(field):
        return len({tuple(r[field]) if isinstance(r[field], tuple) else r[field]
                    for r in rows})
    print(f"records                                  {len(rows)}")
    print(f"roles                                    {len({r['role'] for r in rows})}")
    print(f"role groups                              {len({r['role_group'] for r in rows})}")
    print(f"distinct job_name (folded)               {d('folded')}")
    print(f"distinct job_statement.when              {d('when')}")
    print(f"distinct use_case.trigger                {d('trigger')}")
    print(f"distinct use_case.primary_flow blocks    {d('primary_flow')}")
    print(f"distinct use_case.outputs blocks         {d('outputs')}")
    print(f"distinct acceptance_criteria blocks      {d('acceptance_criteria')}")
    print(f"distinct agentic_design.pattern          {d('pattern')}")
    print(f"catalogue capabilities                   {len(caps)}")
    print(f"capabilities referenced (core or sup.)   {len(set(core) | set(sup))}")
    print(f"capabilities core to >=1 job             {len(core)}")
    print(f"capabilities supporting-only             {len(set(sup) - set(core))}")
    print(f"capabilities referenced by no job        {len({c['capability_id'] for c in caps} - set(core) - set(sup))}")
    print(f"human_approval_required=true             {sum(1 for r in rows if r['approval'])}")
    print(f"target_autonomy=L3                       {sum(1 for r in rows if r['autonomy'] == 'L3')}")
    print("lifecycle spread                         " +
          str(dict(sorted(Counter(r["lifecycle"] for r in rows).items()))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit findings as JSON")
    ap.add_argument("--sweep", action="store_true",
                    help="near-duplicate threshold sensitivity table")
    ap.add_argument("--stats", action="store_true",
                    help="corpus-level template statistics")
    ap.add_argument("--detector", help="run one detector by name")
    ap.add_argument("--threshold", type=float, default=NEAR_DUP_THRESHOLD)
    args = ap.parse_args()

    rows = load_projection(JTBD)

    if args.sweep:
        sweep(rows)
        return 0

    if args.stats:
        stats(rows)
        return 0

    selected = ({args.detector: DETECTORS[args.detector]}
                if args.detector else DETECTORS)
    findings = []
    for name, fn in selected.items():
        findings.extend(fn(rows, args.threshold)
                        if name == "NEAR_DUPLICATE_JOB" else fn(rows))

    # Stable ordering so the committed overlay only changes when a finding does.
    findings.sort(key=lambda f: (f["findingType"],
                                 f["jtbdId"] or "",
                                 ",".join(f["jtbdIds"] or []),
                                 f["evidence"]))

    if args.json:
        json.dump({
            "catalogRecords": len(rows),
            "nearDuplicateThreshold": args.threshold,
            "findings": findings,
        }, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    counts = Counter(f["findingType"] for f in findings)
    basis = Counter((f["findingType"], f["basis"]) for f in findings)
    print(f"records streamed: {len(rows)}")
    print(f"near-duplicate threshold: {args.threshold}")
    print(f"{'findingType':<30} {'count':>6} {'proved':>7} {'suspected':>10}")
    for t in sorted(counts):
        print(f"{t:<30} {counts[t]:>6} {basis[(t, 'proved')]:>7} "
              f"{basis[(t, 'suspected')]:>10}")
    print(f"{'TOTAL':<30} {len(findings):>6} "
          f"{sum(1 for f in findings if f['basis'] == 'proved'):>7} "
          f"{sum(1 for f in findings if f['basis'] == 'suspected'):>10}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
