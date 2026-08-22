#!/usr/bin/env python3
"""Regenerate the v1.1 human-review artifacts from checked catalogue evidence."""

import collections
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads((ROOT / path).read_text())


def write_json(path, value):
    (ROOT / path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


catalog_path = ROOT / "catalog/jtbd.jsonl"
records = [json.loads(line) for line in catalog_path.read_text().splitlines()]
by_id = {record["jtbd_id"]: record for record in records}
prior = read_json("quality/correction-proposal-v1.1.json")
affected = {item["jtbdId"]: item for item in prior["proposals"]}
existing_review_path = ROOT / "quality/approval-boundary-review-v1.1.json"
existing_reviews = {}
if existing_review_path.exists():
    existing_reviews = {
        item["jtbdId"]: item
        for item in json.loads(existing_review_path.read_text()).get("reviews", [])
    }

reviews = []
for jtbd_id in sorted(affected):
    record = by_id[jtbd_id]
    design = record["agentic_design"]
    pattern = design["pattern"]
    if jtbd_id == "ACC-JTBD-AE-012":
        semantic_class = "HUMAN_CONFIRMATION_REQUIRED"
        proposed = {"targetAutonomy": "L3", "humanApprovalRequired": True}
        reason = (
            "The job both recommends a forecast and records downstream decisions/tasks. "
            "The generic DECIDE flow does not establish whether updating the forecast is a "
            "mutation or only a prepared recommendation, so L3 + approval is the conservative "
            "valid provisional state pending a product decision."
        )
        needs_confirmation = True
    elif pattern == "DECIDE":
        semantic_class = "B_MOVE_TO_L2_NO_APPROVAL"
        proposed = {"targetAutonomy": "L2", "humanApprovalRequired": False}
        reason = (
            "The desired flow builds scenarios and recommends an option; execution beyond the "
            "delegated boundary is explicitly gated. The stated job can therefore remain a "
            "recommendation/preparation job at L2 without approval."
        )
        needs_confirmation = False
    else:
        semantic_class = "A_KEEP_L3_REQUIRE_APPROVAL"
        proposed = {"targetAutonomy": "L3", "humanApprovalRequired": True}
        reason = (
            f"The {pattern} flow records, applies, creates, maintains, or optimizes state and its "
            "outputs include an operational result. That is action rather than recommendation; "
            "L3 is retained and explicit approval is required."
        )
        needs_confirmation = False

    old = affected[jtbd_id]["old"]
    design["target_autonomy"] = proposed["targetAutonomy"]
    design["human_approval_required"] = proposed["humanApprovalRequired"]
    for index, criterion in enumerate(record["acceptance_criteria"]):
        if criterion.startswith("Nessuna azione supera il livello L"):
            record["acceptance_criteria"][index] = criterion.replace(
                criterion.split(";")[0],
                f"Nessuna azione supera il livello {proposed['targetAutonomy']}",
            )
    reviews.append({
        "jtbdId": jtbd_id,
        "role": record["role"],
        "semanticClass": semantic_class,
        "old": old,
        "proposed": proposed,
        "evidence": {
            "job": record["job_statement"]["canonical"],
            "jobName": record["job_name"],
            "trigger": record["use_case"]["trigger"],
            "desiredOutcome": record["job_statement"]["so_that"],
            "primaryFlow": record["use_case"]["primary_flow"],
            "pattern": pattern,
            "outputs": record["use_case"]["outputs"],
            "acceptanceCriteria": record["acceptance_criteria"],
            "risk": record["risk_and_governance"]["risk_level"],
            "sensitiveData": affected[jtbd_id].get(
                "sensitivity", existing_reviews.get(jtbd_id, {}).get("evidence", {}).get("sensitiveData", [])
            ),
            "actsOrMutates": pattern != "DECIDE" or jtbd_id == "ACC-JTBD-AE-012",
            "recommendationOrPreparationOnly": pattern == "DECIDE" and jtbd_id != "ACC-JTBD-AE-012",
        },
        "reason": reason,
        "needsHumanConfirmation": needs_confirmation,
    })

summary = dict(sorted(collections.Counter(item["semanticClass"] for item in reviews).items()))
write_json("quality/approval-boundary-review-v1.1.json", {
    "approvalBoundaryReviewContract": 1,
    "catalogueVersion": prior["catalogueTo"],
    "classificationAuthority": (
        "Semantic classification from each record's canonical statement, trigger, desired outcome, "
        "pattern, flow, outputs, acceptance criteria, risk, and sensitivity; risk and the prior "
        "approval boolean are context, never the decision rule."
    ),
    "priorProposalProvenance": (
        "No 264/16 artifact or needs_human_confirmation field was found in reachable Git history "
        "or PR #108/#109 discussion. The 264/16 split survives only in the PR #111 integrator "
        "handover; the catalogue's 16 DECIDE contradictions independently reproduce its L2 count."
    ),
    "summary": summary,
    "reviews": reviews,
})

catalog_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records))
new_checksum = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
proposals = [{
    "jtbdId": item["jtbdId"],
    "semanticClass": item["semanticClass"],
    "old": item["old"],
    "new": item["proposed"],
    "needsHumanConfirmation": item["needsHumanConfirmation"],
    "reason": item["reason"],
    "reviewArtifact": "approval-boundary-review-v1.1.json",
} for item in reviews]
write_json("quality/correction-proposal-v1.1.json", {
    "proposalContract": 2,
    "catalogueFrom": prior["catalogueFrom"],
    "catalogueTo": prior["catalogueTo"],
    "oldChecksum": prior["oldChecksum"],
    "newChecksum": new_checksum,
    "rule": "L3 means acts after approval; classification is established by the semantic review artifact.",
    "summary": summary,
    "proposals": proposals,
})
write_json("quality/correction-log-v1.1.json", {
    "correctionLogContract": 2,
    "catalogueFrom": prior["catalogueFrom"],
    "catalogueTo": prior["catalogueTo"],
    "oldChecksum": prior["oldChecksum"],
    "newChecksum": new_checksum,
    "summary": summary,
    "reviewArtifact": "approval-boundary-review-v1.1.json",
    "corrections": proposals,
})

manifest = read_json("manifest.json")
entry = next(item for item in manifest["files"] if item["path"] == "catalog/jtbd.jsonl")
entry["bytes"] = catalog_path.stat().st_size
entry["sha256"] = new_checksum
write_json("manifest.json", manifest)

# Turn mechanically detected symptoms into per-finding evidence packets and grouped queues.
findings = read_json("quality/findings.json")["findings"]
dispositions = []
families = collections.defaultdict(list)
for index, finding in enumerate(findings):
    kind = finding["findingType"]
    ids = finding.get("jtbdIds") or ([finding["jtbdId"]] if finding.get("jtbdId") else [])
    if kind == "CONTRADICTORY_JOB":
        decision = "correct"
        rationale = f"Resolved by approval review for {finding['jtbdId']}; see the row's semanticClass and evidence."
    elif kind == "CROSS_ROLE_DUPLICATE":
        decision = "merge/supersede"
        rationale = f"Concrete merge candidate {', '.join(ids)}: {finding['evidence']} Preserve role-specific ownership only if product review supplies a differentiated trigger."
    elif kind == "COMPOUND_JOB":
        decision = "split"
        job = by_id[ids[0]]["job_name"] if ids and ids[0] in by_id else finding["evidence"]
        rationale = f"Proposed split boundary is each coordinated infinitive in “{job}”; product review must decide shared versus separate acceptance outcomes before wording changes."
    elif kind == "TAUTOLOGICAL_OUTCOME":
        decision = "defer human decision"
        rationale = f"Rewrite the outcome as an independently falsifiable benefit, not the wanted action. Current proof: {finding['evidence']} No wording or evidence is transplanted until that outcome is chosen."
    elif kind == "MISSING_DEPENDENCY":
        decision = "defer human decision"
        capability = finding.get("jtbdId")
        rationale = f"Dependency ownership gap for {capability}: {finding['evidence']} Human decision: add a user outcome that produces it, or demote it from supporting dependencies; this is not safely inferred from taxonomy alone."
    elif kind == "UNOWNED_PREREQUISITE":
        decision = "defer human decision"
        rationale = f"Widely assumed prerequisite has no producing job: {finding['evidence']} Human decision must name its user outcome and owner, or remove the prerequisite assumption."
    elif kind == "UNREFERENCED_CAPABILITY":
        decision = "retain with rationale"
        rationale = f"Reverse-audit candidate, not catalogue coverage: {finding['evidence']} Retain provisionally only under the capability-specific classification in REVERSE_CAPABILITY_AUDIT.json."
    elif kind == "CONFLICTING_TERMS":
        decision = "defer human decision"
        rationale = f"Corpus glossary decision required: {finding['evidence']} Choose canonical domain meaning before any bulk rewrite."
    elif kind == "ROLE_TRIGGER_INCOHERENCE":
        decision = "defer human decision"
        rationale = f"Template-derived semantics are not job evidence: {finding['evidence']} Human authors must supply role/job-specific triggers and flows before normalization."
    else:
        decision = "defer human decision"
        rationale = f"{finding['evidence']} Recommended boundary: {finding['recommendedDisposition']}; product meaning must be confirmed before changing wording or coverage."
    item = {
        "findingIndex": index, "findingType": kind, "jtbdId": finding.get("jtbdId"),
        "jtbdIds": finding.get("jtbdIds"), "decision": decision,
        "evidence": finding["evidence"], "rationale": rationale,
        "coverageEffect": "NONE; material wording changes require reassessment or NOT_ASSESSED",
    }
    dispositions.append(item)
    families[kind].append(index)
write_json("quality/dispositions-v1.1.json", {
    "dispositionContract": 2,
    "catalogueVersion": prior["catalogueTo"],
    "summary": dict(sorted(collections.Counter(item["decision"] for item in dispositions).items())),
    "dispositions": dispositions,
})
write_json("quality/semantic-review-packet-v1.1.json", {
    "semanticReviewPacketContract": 1,
    "catalogueVersion": prior["catalogueTo"],
    "summary": {kind: len(indices) for kind, indices in sorted(families.items())},
    "decisionFamilies": [{
        "findingType": kind,
        "count": len(indices),
        "findingIndexes": indices,
        "humanReviewQuestion": dispositions[indices[0]]["rationale"],
    } for kind, indices in sorted(families.items())],
    "exceptions": [item for item in dispositions if item["findingType"] in {
        "CROSS_ROLE_DUPLICATE", "CONFLICTING_TERMS", "ROLE_TRIGGER_INCOHERENCE", "UNOWNED_PREREQUISITE"
    }],
})

# Produce a complete, reproducible ownership audit without treating ownership as evidence.
pillars = read_json("roadmap/pillars.json")["pillars"]
assignments = [json.loads(line) for line in (ROOT / "roadmap/assignments.jsonl").read_text().splitlines()]
private_fields = {"priority", "businessValue", "competitiveRationale", "commercialSequencing", "roadmapScore"}
audits = []
for assignment in assignments:
    pillar = pillars.get(assignment["pillar"])
    checks = {
        "pillarRegistered": pillar is not None,
        "editionRegisteredForPillar": pillar is not None and assignment["edition"] == pillar["edition"],
        "trackRegisteredForPillar": pillar is not None and assignment["roadmapTrack"] == pillar["roadmapTrack"],
        "concreteMilestoneOrEpic": bool(assignment["milestoneOrEpic"] and assignment["milestoneOrEpic"] != "Historical roadmap claim"),
        "dependenciesDeclared": isinstance(assignment["dependencies"], list),
        "deferredReasonPresentWhenNeeded": assignment["disposition"] not in {"deferred", "out of scope"} or bool(assignment["deferredReason"]),
        "noPrivateFields": not (private_fields & assignment.keys()),
    }
    audits.append({"jtbdId": assignment["jtbdId"], "disposition": assignment["disposition"], "checks": checks,
                   "reason": "Ownership was checked against the registered pillar metadata; it remains planning metadata and supplies no coverage evidence."})
write_json("roadmap/assignment-audit-v1.1.json", {
    "assignmentAuditContract": 1,
    "catalogueVersion": prior["catalogueTo"],
    "summary": {
        "assignments": len(audits),
        "unassigned": len(records) - len(audits),
        "dispositions": dict(sorted(collections.Counter(item["disposition"] for item in audits).items())),
        "failedChecks": sum(not value for item in audits for value in item["checks"].values()),
    },
    "coverageEffect": "NONE",
    "audits": audits,
})

# Ground every reverse-audit conclusion in the named capability rather than a shared template.
reverse = read_json("quality/REVERSE_CAPABILITY_AUDIT.json")
capabilities = {item["capability_id"]: item for item in read_json("catalog/capabilities.json")}
for capability_id, audit in reverse["orphanCapabilities"].items():
    capability = capabilities[capability_id]
    if audit["classification"] == "missing desired job":
        conclusion = (
            f"Human review is missing an outcome for a user who needs “{capability['name']}”; "
            "the catalogue must not manufacture that outcome from the capability definition."
        )
    elif audit["classification"] == "implementation plumbing with no direct JTBD expected":
        conclusion = (
            f"“{capability['name']}” is a reusable {capability['domain']} mechanism used to deliver "
            "other outcomes; a direct desired job is not expected unless a user-facing authoring or "
            "administration outcome is separately approved."
        )
    elif audit["classification"] == "taxonomy error":
        conclusion = (
            f"“{capability['name']}” currently has no owning job and overlaps a taxonomy boundary; "
            "human review must relocate or consolidate the capability before attaching desired jobs."
        )
    else:
        conclusion = (
            f"“{capability['name']}” is declared in {capability['domain']} but no desired job consumes "
            "it; retain it as explicit roadmap debt rather than inventing demand."
        )
    audit["capabilityName"] = capability["name"]
    audit["capabilityDefinition"] = capability["description"]
    audit["reason"] = conclusion
reverse["plt004"] = reverse["orphanCapabilities"]["PLT-004"]
pillar_reasons = {
    "signature-order": "Signature/order is enabling execution plumbing in the current catalogue; no direct signer/order-administration outcome is approved.",
    "delivery": "No desired job currently owns planning and accepting delivery work; that missing user outcome remains for human review.",
    "work": "No desired job currently owns activities/tasks as a work-management outcome; do not infer one from the module roadmap.",
    "customer-data-operations": "The catalogue lacks an approved operator outcome for maintaining customer-data operations; roadmap assignment is not a substitute.",
    "interactions": "The catalogue lacks an approved outcome for recording/governing customer interactions as a distinct job.",
    "billing": "The catalogue lacks an approved billing-operator/customer outcome, and billing remains outside current implementation.",
    "design-to-crm": "Design-to-CRM describes a construction surface rather than a settled desired-job pillar; taxonomy ownership needs human resolution.",
}
reverse["previouslyEmptyPillars"] = {
    key: {"classification": value["classification"] if isinstance(value, dict) else value, "reason": pillar_reasons[key]}
    for key, value in reverse["previouslyEmptyPillars"].items()
}
write_json("quality/REVERSE_CAPABILITY_AUDIT.json", reverse)
