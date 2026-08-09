PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT
      ) STRICT;
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  target_id TEXT,
  source TEXT CHECK(source IN ('automatic')),
  routing_run_id TEXT,
  previous_assignment_id TEXT,
  effective_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE behavioral_signals (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  signal_type TEXT,
  source TEXT,
  observed_at TEXT,
  value TEXT,
  source_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE definition_versions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        UNIQUE(type, name, version)
      ) STRICT;
CREATE TABLE enrichment_snapshots (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  provider TEXT,
  provider_version INTEGER,
  provider_fingerprint TEXT,
  source_key TEXT UNIQUE,
  status TEXT CHECK(status IN ('complete', 'partial')),
  company_domain TEXT,
  company_name TEXT,
  country TEXT,
  employee_range TEXT,
  industry TEXT,
  revenue_range TEXT,
  language TEXT,
  confidence INTEGER,
  source_ref TEXT,
  retrieved_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_name TEXT,
  source TEXT CHECK(source IN ('website', 'referral', 'event', 'outbound')),
  score INTEGER,
  status TEXT CHECK(status IN ('new', 'qualified', 'disqualified', 'converted')),
  disqualification_reason TEXT,
  qualified_at TEXT,
  converted_at TEXT,
  converted_company_id TEXT,
  converted_contact_id TEXT,
  converted_opportunity_id TEXT,
  enrichment_snapshot_id TEXT,
  enriched_at TEXT,
  score_run_id TEXT,
  scored_at TEXT,
  assigned_target_id TEXT,
  assigned_at TEXT,
  routing_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE module_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE opportunities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('new_business', 'renewal', 'upsell')),
        value_cents INTEGER NOT NULL CHECK(value_cents >= 0),
        currency TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('discovery', 'qualification', 'proposal', 'approval_pending', 'negotiation', 'won', 'lost')),
        owner TEXT NOT NULL,
        expected_close_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , source_key TEXT, pipeline_key TEXT, pipeline_stage TEXT, stage_entered_at TEXT, closed_at TEXT, close_reason TEXT) STRICT;
CREATE TABLE route_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  target_key TEXT,
  kind TEXT,
  eligible INTEGER CHECK(eligible IN (0, 1)),
  reason TEXT,
  current_load INTEGER,
  capacity INTEGER,
  priority INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE routing_runs (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  policy TEXT,
  policy_version INTEGER,
  fingerprint TEXT,
  targets_fingerprint TEXT,
  score_run_id TEXT,
  snapshot_id TEXT,
  evaluated_targets INTEGER,
  eligible_targets INTEGER,
  selected_target TEXT,
  matched_rule TEXT,
  fallback_reason TEXT,
  routed_at TEXT,
  status TEXT CHECK(status IN ('completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
CREATE TABLE score_contributions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  rule_key TEXT,
  label TEXT,
  matched INTEGER CHECK(matched IN (0, 1)),
  contribution INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE score_runs (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  model TEXT,
  model_version INTEGER,
  fingerprint TEXT,
  snapshot_id TEXT,
  signal_count INTEGER,
  signals_fingerprint TEXT,
  lead_fingerprint TEXT,
  total_score INTEGER,
  evaluated_at TEXT,
  status TEXT CHECK(status IN ('completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT CHECK(status IN ('open', 'done')),
  due_at TEXT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  source_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE trace_spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'compensated')),
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
CREATE UNIQUE INDEX approvals_one_pending_per_opportunity
        ON approvals(opportunity_id)
        WHERE status = 'pending';
CREATE INDEX assignments_lead_id ON assignments(lead_id);
CREATE INDEX assignments_target_id ON assignments(target_id);
CREATE INDEX audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX behavioral_signals_lead_id ON behavioral_signals(lead_id);
CREATE INDEX enrichment_snapshots_lead_id ON enrichment_snapshots(lead_id);
CREATE INDEX leads_assigned_target_id ON leads(assigned_target_id);
CREATE INDEX opportunities_pipeline_stage
        ON opportunities(pipeline_key, pipeline_stage);
CREATE UNIQUE INDEX opportunities_source_key
        ON opportunities(source_key)
        WHERE source_key IS NOT NULL;
CREATE INDEX route_evaluations_run_id ON route_evaluations(run_id);
CREATE INDEX routing_runs_lead_id ON routing_runs(lead_id);
CREATE INDEX score_contributions_run_id ON score_contributions(run_id);
CREATE INDEX score_runs_lead_id ON score_runs(lead_id);
CREATE INDEX tasks_lead_id ON tasks(lead_id);
CREATE INDEX trace_spans_run_id ON trace_spans(run_id);
INSERT INTO "assignments" ("id","lead_id","target_id","source","routing_run_id","previous_assignment_id","effective_at","reason","created_at","updated_at") VALUES ('f007ee75-43ba-48bf-b4e8-471286c1807c','4e372272-f970-48c5-8a27-aca26bba759c','unrouted-queue','automatic','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8',NULL,'2026-08-09T07:05:56.362Z','policy declined all eligible targets','2026-08-09T07:05:56.364Z','2026-08-09T07:05:56.364Z');
INSERT INTO "assignments" ("id","lead_id","target_id","source","routing_run_id","previous_assignment_id","effective_at","reason","created_at","updated_at") VALUES ('47434b36-6e08-4b88-8812-4ebdd59ecfae','6c94d389-d956-40a5-83b0-05d9260c0b23','unrouted-queue','automatic','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7',NULL,'2026-08-09T07:05:56.386Z','policy declined all eligible targets','2026-08-09T07:05:56.387Z','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('df386231-0768-4b2c-8c1d-b94eff46271e','user','legacy-operator','lead.created','lead','4e372272-f970-48c5-8a27-aca26bba759c','{"id":"4e372272-f970-48c5-8a27-aca26bba759c","firstName":"Ada","lastName":"Rossi","email":"ada@rossi.example","companyName":"Rossi SpA","source":"website","score":null,"status":"new","disqualificationReason":null,"qualifiedAt":null,"convertedAt":null,"convertedCompanyId":null,"convertedContactId":null,"convertedOpportunityId":null,"enrichmentSnapshotId":null,"enrichedAt":null,"scoreRunId":null,"scoredAt":null,"assignedTargetId":null,"assignedAt":null,"routingRunId":null,"createdAt":"2026-08-09T07:05:56.337Z","updatedAt":"2026-08-09T07:05:56.337Z"}','2026-08-09T07:05:56.338Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('89462246-e437-4363-8d9f-b711809274a8','user','legacy-operator','behavioral-signal.created','behavioral-signal','d26f5d65-8fd8-44c4-b0ea-8af68e0708c9','{"id":"d26f5d65-8fd8-44c4-b0ea-8af68e0708c9","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","signalType":"demo-requested","source":null,"observedAt":"2026-07-01T10:00:00.000Z","value":null,"sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:demo-requested:2026-07-01T10:00:00.000Z","createdAt":"2026-08-09T07:05:56.341Z","updatedAt":"2026-08-09T07:05:56.341Z"}','2026-08-09T07:05:56.341Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('88f5cb97-946b-49c7-9774-69ae36860b03','user','legacy-operator','behavioral-signal.created','behavioral-signal','7dd73168-6642-4514-b8e9-89f82dd017e6','{"id":"7dd73168-6642-4514-b8e9-89f82dd017e6","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","signalType":"pricing-page-visited","source":null,"observedAt":"2026-07-01T11:00:00.000Z","value":null,"sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:pricing-page-visited:2026-07-01T11:00:00.000Z","createdAt":"2026-08-09T07:05:56.344Z","updatedAt":"2026-08-09T07:05:56.344Z"}','2026-08-09T07:05:56.344Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('dc91defd-c577-4abe-beba-2fcdfce2af61','user','legacy-operator','enrichment-snapshot.created','enrichment-snapshot','051dd3e0-b2b3-4127-905f-27e89d4e6a2e','{"id":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","provider":"fixture-firmographics","providerVersion":1,"providerFingerprint":"f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1","sourceKey":"enrich:4e372272-f970-48c5-8a27-aca26bba759c:fixture-firmographics@1:1","status":"partial","companyDomain":"rossi.example","companyName":null,"country":null,"employeeRange":null,"industry":null,"revenueRange":null,"language":null,"confidence":40,"sourceRef":"fixture:rossi.example","retrievedAt":"2026-08-09T07:05:56.347Z","expiresAt":"2026-09-08T07:05:56.347Z","createdAt":"2026-08-09T07:05:56.349Z","updatedAt":"2026-08-09T07:05:56.349Z"}','2026-08-09T07:05:56.350Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('f8c82881-b0f8-4b28-a95d-966457e86386','user','legacy-operator','lead.updated','lead','4e372272-f970-48c5-8a27-aca26bba759c','{"enrichmentSnapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","enrichedAt":"2026-08-09T07:05:56.349Z"}','2026-08-09T07:05:56.350Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('88f846ae-27b1-4080-85a1-0f28f38b367e','user','legacy-operator','score-run.created','score-run','4d86662c-8f0d-4b4e-893c-88073f9b4871','{"id":"4d86662c-8f0d-4b4e-893c-88073f9b4871","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","model":"b2b-saas-score","modelVersion":1,"fingerprint":"ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda","snapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","signalCount":2,"signalsFingerprint":"9897c60a1fd031af71615358fd89cefb3478c0b5fb452bbc084cf5122119dcc0","leadFingerprint":"f66802dcf9f4ece8f9952dff3169d8f0ae0c43f98cf5c442b8da81da61ab8af9","totalScore":35,"evaluatedAt":"2026-08-09T07:05:56.354Z","status":"completed","createdAt":"2026-08-09T07:05:56.356Z","updatedAt":"2026-08-09T07:05:56.356Z"}','2026-08-09T07:05:56.356Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('c3b0964f-db71-497f-9b4f-563da49e54fc','user','legacy-operator','score-contribution.created','score-contribution','29d8e329-c3a4-40b9-9573-f984bcf34582','{"id":"29d8e329-c3a4-40b9-9573-f984bcf34582","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"enterprise-company","label":"Enterprise company size","matched":false,"contribution":0,"reason":"no enterprise employee range","createdAt":"2026-08-09T07:05:56.356Z","updatedAt":"2026-08-09T07:05:56.356Z"}','2026-08-09T07:05:56.356Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('4c79c926-9272-4ab9-b0c8-974e93927cd2','user','legacy-operator','score-contribution.created','score-contribution','ef03d478-dd75-4e90-9716-2e670a9c575a','{"id":"ef03d478-dd75-4e90-9716-2e670a9c575a","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"supported-country","label":"Company in a supported country","matched":false,"contribution":0,"reason":"no supported country evidence","createdAt":"2026-08-09T07:05:56.356Z","updatedAt":"2026-08-09T07:05:56.356Z"}','2026-08-09T07:05:56.356Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('93e3c7ca-1fd4-47d6-85ec-1ffad14ea577','user','legacy-operator','score-contribution.created','score-contribution','6b297913-3fb9-4079-af60-a5a94a093db6','{"id":"6b297913-3fb9-4079-af60-a5a94a093db6","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"demo-requested","label":"Requested a demo","matched":true,"contribution":25,"reason":null,"createdAt":"2026-08-09T07:05:56.357Z","updatedAt":"2026-08-09T07:05:56.357Z"}','2026-08-09T07:05:56.357Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('f5deecf3-772a-4ce6-a606-0d6a009974fa','user','legacy-operator','score-contribution.created','score-contribution','a6b7a8b4-a7ea-4c0e-b195-dabe3adacc74','{"id":"a6b7a8b4-a7ea-4c0e-b195-dabe3adacc74","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"pricing-page-visited","label":"Visited the pricing page","matched":true,"contribution":10,"reason":null,"createdAt":"2026-08-09T07:05:56.357Z","updatedAt":"2026-08-09T07:05:56.357Z"}','2026-08-09T07:05:56.357Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('830e31f3-af9f-49d3-be61-6aeed400b835','user','legacy-operator','score-contribution.created','score-contribution','109ba076-080a-43db-839a-d2b8050dd012','{"id":"109ba076-080a-43db-839a-d2b8050dd012","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"highly-engaged","label":"Highly engaged (declared signal-count threshold)","matched":false,"contribution":0,"reason":null,"createdAt":"2026-08-09T07:05:56.357Z","updatedAt":"2026-08-09T07:05:56.357Z"}','2026-08-09T07:05:56.357Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('26edb662-0332-44e5-b0f2-965685a62523','user','legacy-operator','score-contribution.created','score-contribution','58c61188-dab3-4a48-824c-18f29c6bfeac','{"id":"58c61188-dab3-4a48-824c-18f29c6bfeac","runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","ruleKey":"missing-company-name","label":"No company name on the lead","matched":false,"contribution":0,"reason":null,"createdAt":"2026-08-09T07:05:56.357Z","updatedAt":"2026-08-09T07:05:56.357Z"}','2026-08-09T07:05:56.357Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('16448684-5397-4f19-b7bf-1db2927bbb9c','user','legacy-operator','lead.updated','lead','4e372272-f970-48c5-8a27-aca26bba759c','{"score":35,"scoreRunId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","scoredAt":"2026-08-09T07:05:56.354Z"}','2026-08-09T07:05:56.358Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('23b707b9-8d53-4dfa-b8fe-3fbaaf096795','user','legacy-operator','routing-run.created','routing-run','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','{"id":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","policy":"b2b-sales-routing","policyVersion":1,"fingerprint":"2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2","targetsFingerprint":"dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963","scoreRunId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","snapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","evaluatedTargets":3,"eligibleTargets":2,"selectedTarget":"unrouted-queue","matchedRule":null,"fallbackReason":"policy declined all eligible targets","routedAt":"2026-08-09T07:05:56.362Z","status":"completed","createdAt":"2026-08-09T07:05:56.363Z","updatedAt":"2026-08-09T07:05:56.363Z"}','2026-08-09T07:05:56.363Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('c41a060d-ad5d-4628-98a4-e89e4c55cb3f','user','legacy-operator','route-evaluation.created','route-evaluation','f3f12dd9-ae22-4f94-ae19-314c95601895','{"id":"f3f12dd9-ae22-4f94-ae19-314c95601895","runId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","targetKey":"enterprise-italy","kind":"team","eligible":false,"reason":"score 35 below scoreMin 50","currentLoad":0,"capacity":5,"priority":10,"createdAt":"2026-08-09T07:05:56.364Z","updatedAt":"2026-08-09T07:05:56.364Z"}','2026-08-09T07:05:56.364Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('d6744a3a-8c28-4fec-932f-a69186421723','user','legacy-operator','route-evaluation.created','route-evaluation','a8c89c32-87c9-4fac-bf6d-8b2a80ce3e60','{"id":"a8c89c32-87c9-4fac-bf6d-8b2a80ce3e60","runId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","targetKey":"growth-queue","kind":"queue","eligible":true,"reason":"eligible, not selected","currentLoad":0,"capacity":3,"priority":1,"createdAt":"2026-08-09T07:05:56.364Z","updatedAt":"2026-08-09T07:05:56.364Z"}','2026-08-09T07:05:56.364Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('32f9f2c6-3562-4780-8765-496371ecd07f','user','legacy-operator','route-evaluation.created','route-evaluation','b2565c17-4020-4ab4-a83f-0360a8a52756','{"id":"b2565c17-4020-4ab4-a83f-0360a8a52756","runId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","targetKey":"spain-sales","kind":"team","eligible":true,"reason":"eligible, not selected","currentLoad":0,"capacity":5,"priority":5,"createdAt":"2026-08-09T07:05:56.364Z","updatedAt":"2026-08-09T07:05:56.364Z"}','2026-08-09T07:05:56.364Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('f3188594-d521-4be8-9f77-797abc852200','user','legacy-operator','assignment.created','assignment','f007ee75-43ba-48bf-b4e8-471286c1807c','{"id":"f007ee75-43ba-48bf-b4e8-471286c1807c","leadId":"4e372272-f970-48c5-8a27-aca26bba759c","targetId":"unrouted-queue","source":"automatic","routingRunId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","previousAssignmentId":null,"effectiveAt":"2026-08-09T07:05:56.362Z","reason":"policy declined all eligible targets","createdAt":"2026-08-09T07:05:56.364Z","updatedAt":"2026-08-09T07:05:56.364Z"}','2026-08-09T07:05:56.364Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('48d7e348-529d-4583-8f8f-d6dcdca65441','user','legacy-operator','lead.updated','lead','4e372272-f970-48c5-8a27-aca26bba759c','{"assignedTargetId":"unrouted-queue","assignedAt":"2026-08-09T07:05:56.362Z","routingRunId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8"}','2026-08-09T07:05:56.365Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('4c565036-91cb-4faf-8937-b543c426caf1','user','legacy-operator','lead.created','lead','6c94d389-d956-40a5-83b0-05d9260c0b23','{"id":"6c94d389-d956-40a5-83b0-05d9260c0b23","firstName":"Bo","lastName":"Neri","email":"bo@neri.example","companyName":"Neri SpA","source":"website","score":null,"status":"new","disqualificationReason":null,"qualifiedAt":null,"convertedAt":null,"convertedCompanyId":null,"convertedContactId":null,"convertedOpportunityId":null,"enrichmentSnapshotId":null,"enrichedAt":null,"scoreRunId":null,"scoredAt":null,"assignedTargetId":null,"assignedAt":null,"routingRunId":null,"createdAt":"2026-08-09T07:05:56.367Z","updatedAt":"2026-08-09T07:05:56.367Z"}','2026-08-09T07:05:56.368Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('53fd104e-19f8-4e47-a419-3b44637f1396','user','legacy-operator','behavioral-signal.created','behavioral-signal','d39cb769-9181-4dba-80e8-8469f8579172','{"id":"d39cb769-9181-4dba-80e8-8469f8579172","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","signalType":"demo-requested","source":null,"observedAt":"2026-07-01T10:00:00.000Z","value":null,"sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:demo-requested:2026-07-01T10:00:00.000Z","createdAt":"2026-08-09T07:05:56.368Z","updatedAt":"2026-08-09T07:05:56.368Z"}','2026-08-09T07:05:56.368Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('1f0fcfdd-0209-441c-9cd0-95b1754a790b','user','legacy-operator','behavioral-signal.created','behavioral-signal','773749e1-4053-4f7f-b846-56a7aee799dd','{"id":"773749e1-4053-4f7f-b846-56a7aee799dd","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","signalType":"pricing-page-visited","source":null,"observedAt":"2026-07-01T11:00:00.000Z","value":null,"sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:pricing-page-visited:2026-07-01T11:00:00.000Z","createdAt":"2026-08-09T07:05:56.371Z","updatedAt":"2026-08-09T07:05:56.371Z"}','2026-08-09T07:05:56.371Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('e6a22267-051a-41ba-9995-b407f14fa19e','user','legacy-operator','enrichment-snapshot.created','enrichment-snapshot','fd694748-6270-4262-9873-695f077db97f','{"id":"fd694748-6270-4262-9873-695f077db97f","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","provider":"fixture-firmographics","providerVersion":1,"providerFingerprint":"f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1","sourceKey":"enrich:6c94d389-d956-40a5-83b0-05d9260c0b23:fixture-firmographics@1:1","status":"partial","companyDomain":"neri.example","companyName":null,"country":null,"employeeRange":null,"industry":null,"revenueRange":null,"language":null,"confidence":40,"sourceRef":"fixture:neri.example","retrievedAt":"2026-08-09T07:05:56.375Z","expiresAt":"2026-09-08T07:05:56.375Z","createdAt":"2026-08-09T07:05:56.375Z","updatedAt":"2026-08-09T07:05:56.375Z"}','2026-08-09T07:05:56.375Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('2da697bf-6d24-4e28-965d-4b66dab054b5','user','legacy-operator','lead.updated','lead','6c94d389-d956-40a5-83b0-05d9260c0b23','{"enrichmentSnapshotId":"fd694748-6270-4262-9873-695f077db97f","enrichedAt":"2026-08-09T07:05:56.375Z"}','2026-08-09T07:05:56.376Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('4923d143-cca5-43c6-806a-be1722662610','user','legacy-operator','score-run.created','score-run','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','{"id":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","model":"b2b-saas-score","modelVersion":1,"fingerprint":"ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda","snapshotId":"fd694748-6270-4262-9873-695f077db97f","signalCount":2,"signalsFingerprint":"07951cdfb84cc0de3b1f062483a41e44b1c328bd6e7180b60c970f0e502d3e64","leadFingerprint":"631c690ad58fc231a0f6e17687a14102a98f06cf3a7ea03ef788fdae49ecb864","totalScore":35,"evaluatedAt":"2026-08-09T07:05:56.381Z","status":"completed","createdAt":"2026-08-09T07:05:56.381Z","updatedAt":"2026-08-09T07:05:56.381Z"}','2026-08-09T07:05:56.381Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('e16614a8-b227-43c8-85c0-dea5554bef11','user','legacy-operator','score-contribution.created','score-contribution','4545763c-ccd4-4431-8cad-37b7e08ce309','{"id":"4545763c-ccd4-4431-8cad-37b7e08ce309","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"enterprise-company","label":"Enterprise company size","matched":false,"contribution":0,"reason":"no enterprise employee range","createdAt":"2026-08-09T07:05:56.381Z","updatedAt":"2026-08-09T07:05:56.381Z"}','2026-08-09T07:05:56.381Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('30391c46-e8de-4f2f-87b0-2d57f6474a2f','user','legacy-operator','score-contribution.created','score-contribution','43882306-1013-438f-9812-94f5b0f36bf4','{"id":"43882306-1013-438f-9812-94f5b0f36bf4","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"supported-country","label":"Company in a supported country","matched":false,"contribution":0,"reason":"no supported country evidence","createdAt":"2026-08-09T07:05:56.382Z","updatedAt":"2026-08-09T07:05:56.382Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('32ab8f17-359f-4757-8117-79b9a43e656e','user','legacy-operator','score-contribution.created','score-contribution','7714f0b6-b6c3-410c-904a-282ac31e332a','{"id":"7714f0b6-b6c3-410c-904a-282ac31e332a","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"demo-requested","label":"Requested a demo","matched":true,"contribution":25,"reason":null,"createdAt":"2026-08-09T07:05:56.382Z","updatedAt":"2026-08-09T07:05:56.382Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('52580bee-1b30-4105-8309-8ea479a29d87','user','legacy-operator','score-contribution.created','score-contribution','3779034d-f4e9-439c-8311-4c67886d48e3','{"id":"3779034d-f4e9-439c-8311-4c67886d48e3","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"pricing-page-visited","label":"Visited the pricing page","matched":true,"contribution":10,"reason":null,"createdAt":"2026-08-09T07:05:56.382Z","updatedAt":"2026-08-09T07:05:56.382Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('68337b9a-4b68-4e44-9e83-9719f1090db8','user','legacy-operator','score-contribution.created','score-contribution','47122ce0-702e-42f2-8f8d-b1c7ec8c3258','{"id":"47122ce0-702e-42f2-8f8d-b1c7ec8c3258","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"highly-engaged","label":"Highly engaged (declared signal-count threshold)","matched":false,"contribution":0,"reason":null,"createdAt":"2026-08-09T07:05:56.382Z","updatedAt":"2026-08-09T07:05:56.382Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('7d4e99e9-d5b3-4970-a76f-58908cc3c084','user','legacy-operator','score-contribution.created','score-contribution','6007ba2b-4979-4372-a4c2-4a407365de31','{"id":"6007ba2b-4979-4372-a4c2-4a407365de31","runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","ruleKey":"missing-company-name","label":"No company name on the lead","matched":false,"contribution":0,"reason":null,"createdAt":"2026-08-09T07:05:56.382Z","updatedAt":"2026-08-09T07:05:56.382Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('9d3b7848-9497-4122-9896-2ff62fa732ce','user','legacy-operator','lead.updated','lead','6c94d389-d956-40a5-83b0-05d9260c0b23','{"score":35,"scoreRunId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","scoredAt":"2026-08-09T07:05:56.381Z"}','2026-08-09T07:05:56.382Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('a6ff289d-fd6f-4e07-9077-b87727d0500b','user','legacy-operator','routing-run.created','routing-run','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','{"id":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","policy":"b2b-sales-routing","policyVersion":1,"fingerprint":"2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2","targetsFingerprint":"dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963","scoreRunId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","snapshotId":"fd694748-6270-4262-9873-695f077db97f","evaluatedTargets":3,"eligibleTargets":2,"selectedTarget":"unrouted-queue","matchedRule":null,"fallbackReason":"policy declined all eligible targets","routedAt":"2026-08-09T07:05:56.386Z","status":"completed","createdAt":"2026-08-09T07:05:56.387Z","updatedAt":"2026-08-09T07:05:56.387Z"}','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('6d1fb46a-dc65-4144-afb3-a4c3fa03b1ac','user','legacy-operator','route-evaluation.created','route-evaluation','fcc84ad5-6229-4d68-a792-43ef15802921','{"id":"fcc84ad5-6229-4d68-a792-43ef15802921","runId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","targetKey":"enterprise-italy","kind":"team","eligible":false,"reason":"score 35 below scoreMin 50","currentLoad":0,"capacity":5,"priority":10,"createdAt":"2026-08-09T07:05:56.387Z","updatedAt":"2026-08-09T07:05:56.387Z"}','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('8fbf6a96-056a-4e18-bf9b-a56ac729673f','user','legacy-operator','route-evaluation.created','route-evaluation','03fc03aa-66e7-40b6-9240-8090ce88e03b','{"id":"03fc03aa-66e7-40b6-9240-8090ce88e03b","runId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","targetKey":"growth-queue","kind":"queue","eligible":true,"reason":"eligible, not selected","currentLoad":0,"capacity":3,"priority":1,"createdAt":"2026-08-09T07:05:56.387Z","updatedAt":"2026-08-09T07:05:56.387Z"}','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('e529672c-6452-4853-bbe8-168f80d31469','user','legacy-operator','route-evaluation.created','route-evaluation','88c831e3-3a6f-4616-a7ba-095d0116d23c','{"id":"88c831e3-3a6f-4616-a7ba-095d0116d23c","runId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","targetKey":"spain-sales","kind":"team","eligible":true,"reason":"eligible, not selected","currentLoad":0,"capacity":5,"priority":5,"createdAt":"2026-08-09T07:05:56.387Z","updatedAt":"2026-08-09T07:05:56.387Z"}','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('6034689f-7083-4397-9b3c-580c95146fc7','user','legacy-operator','assignment.created','assignment','47434b36-6e08-4b88-8812-4ebdd59ecfae','{"id":"47434b36-6e08-4b88-8812-4ebdd59ecfae","leadId":"6c94d389-d956-40a5-83b0-05d9260c0b23","targetId":"unrouted-queue","source":"automatic","routingRunId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","previousAssignmentId":null,"effectiveAt":"2026-08-09T07:05:56.386Z","reason":"policy declined all eligible targets","createdAt":"2026-08-09T07:05:56.387Z","updatedAt":"2026-08-09T07:05:56.387Z"}','2026-08-09T07:05:56.387Z');
INSERT INTO "audit_events" ("id","actor_type","actor_id","action","entity_type","entity_id","data_json","created_at") VALUES ('86cb7239-6c30-404d-87a7-3e511aaf5645','user','legacy-operator','lead.updated','lead','6c94d389-d956-40a5-83b0-05d9260c0b23','{"assignedTargetId":"unrouted-queue","assignedAt":"2026-08-09T07:05:56.386Z","routingRunId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7"}','2026-08-09T07:05:56.388Z');
INSERT INTO "behavioral_signals" ("id","lead_id","signal_type","source","observed_at","value","source_key","created_at","updated_at") VALUES ('d26f5d65-8fd8-44c4-b0ea-8af68e0708c9','4e372272-f970-48c5-8a27-aca26bba759c','demo-requested',NULL,'2026-07-01T10:00:00.000Z',NULL,'signal:4e372272-f970-48c5-8a27-aca26bba759c:demo-requested:2026-07-01T10:00:00.000Z','2026-08-09T07:05:56.341Z','2026-08-09T07:05:56.341Z');
INSERT INTO "behavioral_signals" ("id","lead_id","signal_type","source","observed_at","value","source_key","created_at","updated_at") VALUES ('7dd73168-6642-4514-b8e9-89f82dd017e6','4e372272-f970-48c5-8a27-aca26bba759c','pricing-page-visited',NULL,'2026-07-01T11:00:00.000Z',NULL,'signal:4e372272-f970-48c5-8a27-aca26bba759c:pricing-page-visited:2026-07-01T11:00:00.000Z','2026-08-09T07:05:56.344Z','2026-08-09T07:05:56.344Z');
INSERT INTO "behavioral_signals" ("id","lead_id","signal_type","source","observed_at","value","source_key","created_at","updated_at") VALUES ('d39cb769-9181-4dba-80e8-8469f8579172','6c94d389-d956-40a5-83b0-05d9260c0b23','demo-requested',NULL,'2026-07-01T10:00:00.000Z',NULL,'signal:6c94d389-d956-40a5-83b0-05d9260c0b23:demo-requested:2026-07-01T10:00:00.000Z','2026-08-09T07:05:56.368Z','2026-08-09T07:05:56.368Z');
INSERT INTO "behavioral_signals" ("id","lead_id","signal_type","source","observed_at","value","source_key","created_at","updated_at") VALUES ('773749e1-4053-4f7f-b846-56a7aee799dd','6c94d389-d956-40a5-83b0-05d9260c0b23','pricing-page-visited',NULL,'2026-07-01T11:00:00.000Z',NULL,'signal:6c94d389-d956-40a5-83b0-05d9260c0b23:pricing-page-visited:2026-07-01T11:00:00.000Z','2026-08-09T07:05:56.371Z','2026-08-09T07:05:56.371Z');
INSERT INTO "definition_versions" ("id","type","name","version","fingerprint","registered_at") VALUES ('ae52cae9-a147-46f1-8f91-7b6b779f5063','enrichment-provider','fixture-firmographics',1,'f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1','2026-08-09T07:05:56.335Z');
INSERT INTO "definition_versions" ("id","type","name","version","fingerprint","registered_at") VALUES ('1e4e9c87-44fb-4a11-9d4a-0bb73812ab84','scoring-model','b2b-saas-score',1,'ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda','2026-08-09T07:05:56.335Z');
INSERT INTO "definition_versions" ("id","type","name","version","fingerprint","registered_at") VALUES ('4d581007-b0d3-47a5-90a8-a24d6ca70971','scoring-model','b2b-saas-score',2,'8fe68275a23cf455f3b19ebdcef93764901459819c78d0a15999debf10b8bdb9','2026-08-09T07:05:56.335Z');
INSERT INTO "definition_versions" ("id","type","name","version","fingerprint","registered_at") VALUES ('814737fe-c610-4a19-aac8-48012b98425f','routing-policy','b2b-sales-routing',1,'2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2','2026-08-09T07:05:56.335Z');
INSERT INTO "definition_versions" ("id","type","name","version","fingerprint","registered_at") VALUES ('e676301f-bc90-4028-bf71-63822022eab6','routing-policy','b2b-sales-routing',2,'f7ce988c12b8af897b983d6e3148704bbd703b49ece929c42b40dd6c8ca8c1ed','2026-08-09T07:05:56.335Z');
INSERT INTO "enrichment_snapshots" ("id","lead_id","provider","provider_version","provider_fingerprint","source_key","status","company_domain","company_name","country","employee_range","industry","revenue_range","language","confidence","source_ref","retrieved_at","expires_at","created_at","updated_at") VALUES ('051dd3e0-b2b3-4127-905f-27e89d4e6a2e','4e372272-f970-48c5-8a27-aca26bba759c','fixture-firmographics',1,'f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1','enrich:4e372272-f970-48c5-8a27-aca26bba759c:fixture-firmographics@1:1','partial','rossi.example',NULL,NULL,NULL,NULL,NULL,NULL,40,'fixture:rossi.example','2026-08-09T07:05:56.347Z','2026-09-08T07:05:56.347Z','2026-08-09T07:05:56.349Z','2026-08-09T07:05:56.349Z');
INSERT INTO "enrichment_snapshots" ("id","lead_id","provider","provider_version","provider_fingerprint","source_key","status","company_domain","company_name","country","employee_range","industry","revenue_range","language","confidence","source_ref","retrieved_at","expires_at","created_at","updated_at") VALUES ('fd694748-6270-4262-9873-695f077db97f','6c94d389-d956-40a5-83b0-05d9260c0b23','fixture-firmographics',1,'f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1','enrich:6c94d389-d956-40a5-83b0-05d9260c0b23:fixture-firmographics@1:1','partial','neri.example',NULL,NULL,NULL,NULL,NULL,NULL,40,'fixture:neri.example','2026-08-09T07:05:56.375Z','2026-09-08T07:05:56.375Z','2026-08-09T07:05:56.375Z','2026-08-09T07:05:56.375Z');
INSERT INTO "leads" ("id","first_name","last_name","email","company_name","source","score","status","disqualification_reason","qualified_at","converted_at","converted_company_id","converted_contact_id","converted_opportunity_id","enrichment_snapshot_id","enriched_at","score_run_id","scored_at","assigned_target_id","assigned_at","routing_run_id","created_at","updated_at") VALUES ('4e372272-f970-48c5-8a27-aca26bba759c','Ada','Rossi','ada@rossi.example','Rossi SpA','website',35,'new',NULL,NULL,NULL,NULL,NULL,NULL,'051dd3e0-b2b3-4127-905f-27e89d4e6a2e','2026-08-09T07:05:56.349Z','4d86662c-8f0d-4b4e-893c-88073f9b4871','2026-08-09T07:05:56.354Z','unrouted-queue','2026-08-09T07:05:56.362Z','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','2026-08-09T07:05:56.337Z','2026-08-09T07:05:56.365Z');
INSERT INTO "leads" ("id","first_name","last_name","email","company_name","source","score","status","disqualification_reason","qualified_at","converted_at","converted_company_id","converted_contact_id","converted_opportunity_id","enrichment_snapshot_id","enriched_at","score_run_id","scored_at","assigned_target_id","assigned_at","routing_run_id","created_at","updated_at") VALUES ('6c94d389-d956-40a5-83b0-05d9260c0b23','Bo','Neri','bo@neri.example','Neri SpA','website',35,'new',NULL,NULL,NULL,NULL,NULL,NULL,'fd694748-6270-4262-9873-695f077db97f','2026-08-09T07:05:56.375Z','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','2026-08-09T07:05:56.381Z','unrouted-queue','2026-08-09T07:05:56.386Z','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','2026-08-09T07:05:56.367Z','2026-08-09T07:05:56.388Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_assignments','440652466cee2d7619dce867eb4721bc28ce903622164171829c4f5676d8b605','2026-08-09T07:05:56.325Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_behavioral_signals','517158c1b6815cdcde0fd96d8fb7a105e00e8cbddcff07685ef8d6f352fa85ef','2026-08-09T07:05:56.326Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_enrichment_snapshots','7e0be7ae53c5011877b7d03165c1047ad2d895283c2b51a6b4fc2c708d5e6bb1','2026-08-09T07:05:56.326Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_leads','7b6f4e78043db3730320a283a184c7a6272226dd8b3cbed2cf88f286b1eadf1e','2026-08-09T07:05:56.327Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_route_evaluations','4659a518a58541b21674d8d3c1c7e1fd88fb809d956d6459bd79e8813748cb8e','2026-08-09T07:05:56.328Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_routing_runs','c05e9be20ae4f357eda0df95e848b8eb07704db6e8458b1e0573ea16c5f6f32c','2026-08-09T07:05:56.329Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_score_contributions','cea3df0041a58291f4bb955632a1363a1a4859525a3b7680f21ef43b5b09a2f5','2026-08-09T07:05:56.330Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_score_runs','c885a89e0a0603f574e0aeb9004bddfbe4e00fcfa91538b73c7343ffb8355ad7','2026-08-09T07:05:56.330Z');
INSERT INTO "module_migrations" ("name","checksum","applied_at") VALUES ('create_tasks','b167e0aeda88939beb35523aa82761581b8a2c351098f6402bf6f3487a4141e0','2026-08-09T07:05:56.331Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('f3f12dd9-ae22-4f94-ae19-314c95601895','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','enterprise-italy','team',0,'score 35 below scoreMin 50',0,5,10,'2026-08-09T07:05:56.364Z','2026-08-09T07:05:56.364Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('a8c89c32-87c9-4fac-bf6d-8b2a80ce3e60','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','growth-queue','queue',1,'eligible, not selected',0,3,1,'2026-08-09T07:05:56.364Z','2026-08-09T07:05:56.364Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('b2565c17-4020-4ab4-a83f-0360a8a52756','f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','spain-sales','team',1,'eligible, not selected',0,5,5,'2026-08-09T07:05:56.364Z','2026-08-09T07:05:56.364Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('fcc84ad5-6229-4d68-a792-43ef15802921','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','enterprise-italy','team',0,'score 35 below scoreMin 50',0,5,10,'2026-08-09T07:05:56.387Z','2026-08-09T07:05:56.387Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('03fc03aa-66e7-40b6-9240-8090ce88e03b','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','growth-queue','queue',1,'eligible, not selected',0,3,1,'2026-08-09T07:05:56.387Z','2026-08-09T07:05:56.387Z');
INSERT INTO "route_evaluations" ("id","run_id","target_key","kind","eligible","reason","current_load","capacity","priority","created_at","updated_at") VALUES ('88c831e3-3a6f-4616-a7ba-095d0116d23c','e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','spain-sales','team',1,'eligible, not selected',0,5,5,'2026-08-09T07:05:56.387Z','2026-08-09T07:05:56.387Z');
INSERT INTO "routing_runs" ("id","lead_id","policy","policy_version","fingerprint","targets_fingerprint","score_run_id","snapshot_id","evaluated_targets","eligible_targets","selected_target","matched_rule","fallback_reason","routed_at","status","created_at","updated_at") VALUES ('f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8','4e372272-f970-48c5-8a27-aca26bba759c','b2b-sales-routing',1,'2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2','dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963','4d86662c-8f0d-4b4e-893c-88073f9b4871','051dd3e0-b2b3-4127-905f-27e89d4e6a2e',3,2,'unrouted-queue',NULL,'policy declined all eligible targets','2026-08-09T07:05:56.362Z','completed','2026-08-09T07:05:56.363Z','2026-08-09T07:05:56.363Z');
INSERT INTO "routing_runs" ("id","lead_id","policy","policy_version","fingerprint","targets_fingerprint","score_run_id","snapshot_id","evaluated_targets","eligible_targets","selected_target","matched_rule","fallback_reason","routed_at","status","created_at","updated_at") VALUES ('e0aaf94e-f00f-48dc-b20e-addc2baf3ae7','6c94d389-d956-40a5-83b0-05d9260c0b23','b2b-sales-routing',1,'2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2','dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','fd694748-6270-4262-9873-695f077db97f',3,2,'unrouted-queue',NULL,'policy declined all eligible targets','2026-08-09T07:05:56.386Z','completed','2026-08-09T07:05:56.387Z','2026-08-09T07:05:56.387Z');
INSERT INTO "schema_migrations" ("version","name","applied_at") VALUES (1,'initial_crm_schema','2026-08-09T07:05:56.319Z');
INSERT INTO "schema_migrations" ("version","name","applied_at") VALUES (2,'opportunity_source_key','2026-08-09T07:05:56.321Z');
INSERT INTO "schema_migrations" ("version","name","applied_at") VALUES (3,'opportunity_pipeline_state','2026-08-09T07:05:56.322Z');
INSERT INTO "schema_migrations" ("version","name","applied_at") VALUES (4,'definition_versions','2026-08-09T07:05:56.323Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('29d8e329-c3a4-40b9-9573-f984bcf34582','4d86662c-8f0d-4b4e-893c-88073f9b4871','enterprise-company','Enterprise company size',0,0,'no enterprise employee range','2026-08-09T07:05:56.356Z','2026-08-09T07:05:56.356Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('ef03d478-dd75-4e90-9716-2e670a9c575a','4d86662c-8f0d-4b4e-893c-88073f9b4871','supported-country','Company in a supported country',0,0,'no supported country evidence','2026-08-09T07:05:56.356Z','2026-08-09T07:05:56.356Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('6b297913-3fb9-4079-af60-a5a94a093db6','4d86662c-8f0d-4b4e-893c-88073f9b4871','demo-requested','Requested a demo',1,25,NULL,'2026-08-09T07:05:56.357Z','2026-08-09T07:05:56.357Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('a6b7a8b4-a7ea-4c0e-b195-dabe3adacc74','4d86662c-8f0d-4b4e-893c-88073f9b4871','pricing-page-visited','Visited the pricing page',1,10,NULL,'2026-08-09T07:05:56.357Z','2026-08-09T07:05:56.357Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('109ba076-080a-43db-839a-d2b8050dd012','4d86662c-8f0d-4b4e-893c-88073f9b4871','highly-engaged','Highly engaged (declared signal-count threshold)',0,0,NULL,'2026-08-09T07:05:56.357Z','2026-08-09T07:05:56.357Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('58c61188-dab3-4a48-824c-18f29c6bfeac','4d86662c-8f0d-4b4e-893c-88073f9b4871','missing-company-name','No company name on the lead',0,0,NULL,'2026-08-09T07:05:56.357Z','2026-08-09T07:05:56.357Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('4545763c-ccd4-4431-8cad-37b7e08ce309','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','enterprise-company','Enterprise company size',0,0,'no enterprise employee range','2026-08-09T07:05:56.381Z','2026-08-09T07:05:56.381Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('43882306-1013-438f-9812-94f5b0f36bf4','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','supported-country','Company in a supported country',0,0,'no supported country evidence','2026-08-09T07:05:56.382Z','2026-08-09T07:05:56.382Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('7714f0b6-b6c3-410c-904a-282ac31e332a','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','demo-requested','Requested a demo',1,25,NULL,'2026-08-09T07:05:56.382Z','2026-08-09T07:05:56.382Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('3779034d-f4e9-439c-8311-4c67886d48e3','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','pricing-page-visited','Visited the pricing page',1,10,NULL,'2026-08-09T07:05:56.382Z','2026-08-09T07:05:56.382Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('47122ce0-702e-42f2-8f8d-b1c7ec8c3258','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','highly-engaged','Highly engaged (declared signal-count threshold)',0,0,NULL,'2026-08-09T07:05:56.382Z','2026-08-09T07:05:56.382Z');
INSERT INTO "score_contributions" ("id","run_id","rule_key","label","matched","contribution","reason","created_at","updated_at") VALUES ('6007ba2b-4979-4372-a4c2-4a407365de31','98fd752f-2f5c-4fb4-8748-8dec7ce9696c','missing-company-name','No company name on the lead',0,0,NULL,'2026-08-09T07:05:56.382Z','2026-08-09T07:05:56.382Z');
INSERT INTO "score_runs" ("id","lead_id","model","model_version","fingerprint","snapshot_id","signal_count","signals_fingerprint","lead_fingerprint","total_score","evaluated_at","status","created_at","updated_at") VALUES ('4d86662c-8f0d-4b4e-893c-88073f9b4871','4e372272-f970-48c5-8a27-aca26bba759c','b2b-saas-score',1,'ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda','051dd3e0-b2b3-4127-905f-27e89d4e6a2e',2,'9897c60a1fd031af71615358fd89cefb3478c0b5fb452bbc084cf5122119dcc0','f66802dcf9f4ece8f9952dff3169d8f0ae0c43f98cf5c442b8da81da61ab8af9',35,'2026-08-09T07:05:56.354Z','completed','2026-08-09T07:05:56.356Z','2026-08-09T07:05:56.356Z');
INSERT INTO "score_runs" ("id","lead_id","model","model_version","fingerprint","snapshot_id","signal_count","signals_fingerprint","lead_fingerprint","total_score","evaluated_at","status","created_at","updated_at") VALUES ('98fd752f-2f5c-4fb4-8748-8dec7ce9696c','6c94d389-d956-40a5-83b0-05d9260c0b23','b2b-saas-score',1,'ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda','fd694748-6270-4262-9873-695f077db97f',2,'07951cdfb84cc0de3b1f062483a41e44b1c328bd6e7180b60c970f0e502d3e64','631c690ad58fc231a0f6e17687a14102a98f06cf3a7ea03ef788fdae49ecb864',35,'2026-08-09T07:05:56.381Z','completed','2026-08-09T07:05:56.381Z','2026-08-09T07:05:56.381Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('7d1cdb39-8155-4de5-8f51-5e3f6d849e58','c65543ff-491b-47d9-a099-e876de385ad3',NULL,'lead.record-signal','completed',NULL,'null',NULL,'2026-08-09T07:05:56.339Z','2026-08-09T07:05:56.343Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('e923aa66-0877-46cb-97c4-5e8e032d04c4','c65543ff-491b-47d9-a099-e876de385ad3',NULL,'signal.recorded','completed',NULL,'{"signalId":"d26f5d65-8fd8-44c4-b0ea-8af68e0708c9","sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:demo-requested:2026-07-01T10:00:00.000Z"}',NULL,'2026-08-09T07:05:56.339Z','2026-08-09T07:05:56.343Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('f2e6f445-11b4-4c28-9e79-445d2a3fd6f4','7afc8880-7784-47c3-8ad7-1a8fede618dc',NULL,'lead.record-signal','completed',NULL,'null',NULL,'2026-08-09T07:05:56.344Z','2026-08-09T07:05:56.345Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('cfe790ef-abec-4470-8f9e-0dd31e18d2b6','7afc8880-7784-47c3-8ad7-1a8fede618dc',NULL,'signal.recorded','completed',NULL,'{"signalId":"7dd73168-6642-4514-b8e9-89f82dd017e6","sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:pricing-page-visited:2026-07-01T11:00:00.000Z"}',NULL,'2026-08-09T07:05:56.344Z','2026-08-09T07:05:56.345Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('28de2c74-e7eb-4955-a288-ac7f10925eae','a841e758-6f8a-4c83-8bd4-50beb8ba9584',NULL,'lead.enrich','completed',NULL,'null',NULL,'2026-08-09T07:05:56.347Z','2026-08-09T07:05:56.351Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('72251be4-489c-4f4e-b17f-ff300e515515','a841e758-6f8a-4c83-8bd4-50beb8ba9584',NULL,'enrich.provider','completed',NULL,'{"provider":"fixture-firmographics","version":1,"status":"partial"}',NULL,'2026-08-09T07:05:56.347Z','2026-08-09T07:05:56.351Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('65ab767c-9d04-4e8c-9086-cb7c602ae85e','a841e758-6f8a-4c83-8bd4-50beb8ba9584',NULL,'enrich.snapshot','completed',NULL,'{"snapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","sourceKey":"enrich:4e372272-f970-48c5-8a27-aca26bba759c:fixture-firmographics@1:1","status":"partial"}',NULL,'2026-08-09T07:05:56.347Z','2026-08-09T07:05:56.351Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('3ad5e92f-886b-4f0d-8359-d7ce8ed4fbf7','eb53c130-ba98-4875-a2e4-7db6705b10c0',NULL,'lead.score','completed',NULL,'null',NULL,'2026-08-09T07:05:56.354Z','2026-08-09T07:05:56.359Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('add4b20e-b35f-463e-9022-917610f8c98e','eb53c130-ba98-4875-a2e4-7db6705b10c0',NULL,'score.evaluated','completed',NULL,'{"runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","model":"b2b-saas-score","version":1,"total":35}',NULL,'2026-08-09T07:05:56.354Z','2026-08-09T07:05:56.359Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('86fb0e34-f849-411d-83b9-93f148cba258','b99a9316-2fea-4ea9-bea2-81ad409afa2d',NULL,'lead.route','completed',NULL,'null',NULL,'2026-08-09T07:05:56.361Z','2026-08-09T07:05:56.366Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('4ea32e66-cefa-4465-980d-7ddd48304a39','b99a9316-2fea-4ea9-bea2-81ad409afa2d',NULL,'route.assigned','completed',NULL,'{"runId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","target":"unrouted-queue","fallback":true}',NULL,'2026-08-09T07:05:56.361Z','2026-08-09T07:05:56.366Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('c352b4ec-67b7-4907-ad58-d2cce3c6a1fd','8a3b91b3-387e-4475-b918-d8d254d4c6b3',NULL,'lead.record-signal','completed',NULL,'null',NULL,'2026-08-09T07:05:56.368Z','2026-08-09T07:05:56.369Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('0435bd07-9a61-4ff1-a2cf-a055d53eba7b','8a3b91b3-387e-4475-b918-d8d254d4c6b3',NULL,'signal.recorded','completed',NULL,'{"signalId":"d39cb769-9181-4dba-80e8-8469f8579172","sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:demo-requested:2026-07-01T10:00:00.000Z"}',NULL,'2026-08-09T07:05:56.368Z','2026-08-09T07:05:56.369Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('9c14d31b-06e1-44e2-a272-6dbb8625743c','d6f49570-0d7c-488c-8abe-5a686f6b746d',NULL,'lead.record-signal','completed',NULL,'null',NULL,'2026-08-09T07:05:56.371Z','2026-08-09T07:05:56.372Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('1150bc31-0f34-4006-a3b4-6ff380ff0c0c','d6f49570-0d7c-488c-8abe-5a686f6b746d',NULL,'signal.recorded','completed',NULL,'{"signalId":"773749e1-4053-4f7f-b846-56a7aee799dd","sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:pricing-page-visited:2026-07-01T11:00:00.000Z"}',NULL,'2026-08-09T07:05:56.371Z','2026-08-09T07:05:56.372Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('da27c682-17d2-4188-8a2a-a83567204294','d3001d20-5aae-41a8-9f65-e7ff18ed5e17',NULL,'lead.enrich','completed',NULL,'null',NULL,'2026-08-09T07:05:56.374Z','2026-08-09T07:05:56.377Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('51ca9b22-9392-492a-895a-58aba54c79b2','d3001d20-5aae-41a8-9f65-e7ff18ed5e17',NULL,'enrich.provider','completed',NULL,'{"provider":"fixture-firmographics","version":1,"status":"partial"}',NULL,'2026-08-09T07:05:56.374Z','2026-08-09T07:05:56.377Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('e7fa9aec-22b9-4f28-8224-bd7e30315ac8','d3001d20-5aae-41a8-9f65-e7ff18ed5e17',NULL,'enrich.snapshot','completed',NULL,'{"snapshotId":"fd694748-6270-4262-9873-695f077db97f","sourceKey":"enrich:6c94d389-d956-40a5-83b0-05d9260c0b23:fixture-firmographics@1:1","status":"partial"}',NULL,'2026-08-09T07:05:56.374Z','2026-08-09T07:05:56.377Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('5a5e8839-d9db-47d6-afec-08c3b26201b8','834d06ae-6d62-4fba-bfea-4924440372bb',NULL,'lead.score','completed',NULL,'null',NULL,'2026-08-09T07:05:56.381Z','2026-08-09T07:05:56.383Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('15696a56-0063-4955-bdb6-dff5590b29c5','834d06ae-6d62-4fba-bfea-4924440372bb',NULL,'score.evaluated','completed',NULL,'{"runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","model":"b2b-saas-score","version":1,"total":35}',NULL,'2026-08-09T07:05:56.381Z','2026-08-09T07:05:56.383Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('ded9c520-8deb-4747-9e0e-f6fcdb8a6a9f','413d3863-a55a-4253-8f85-f917b2677593',NULL,'lead.route','completed',NULL,'null',NULL,'2026-08-09T07:05:56.386Z','2026-08-09T07:05:56.389Z');
INSERT INTO "trace_spans" ("id","run_id","parent_span_id","name","status","input_json","output_json","error","started_at","finished_at") VALUES ('780191a4-bc45-4756-be90-78b9733db8c0','413d3863-a55a-4253-8f85-f917b2677593',NULL,'route.assigned','completed',NULL,'{"runId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","target":"unrouted-queue","fallback":true}',NULL,'2026-08-09T07:05:56.386Z','2026-08-09T07:05:56.389Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('c65543ff-491b-47d9-a099-e876de385ad3','lead.record-signal','completed','{"recordId":"4e372272-f970-48c5-8a27-aca26bba759c","input":{"signalType":"demo-requested","observedAt":"2026-07-01T10:00:00.000Z"},"actor":{"type":"user","id":"legacy-operator"}}','{"signal":{"id":"d26f5d65-8fd8-44c4-b0ea-8af68e0708c9","signalType":"demo-requested","observedAt":"2026-07-01T10:00:00.000Z","sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:demo-requested:2026-07-01T10:00:00.000Z"}}',NULL,'2026-08-09T07:05:56.339Z','2026-08-09T07:05:56.343Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('7afc8880-7784-47c3-8ad7-1a8fede618dc','lead.record-signal','completed','{"recordId":"4e372272-f970-48c5-8a27-aca26bba759c","input":{"signalType":"pricing-page-visited","observedAt":"2026-07-01T11:00:00.000Z"},"actor":{"type":"user","id":"legacy-operator"}}','{"signal":{"id":"7dd73168-6642-4514-b8e9-89f82dd017e6","signalType":"pricing-page-visited","observedAt":"2026-07-01T11:00:00.000Z","sourceKey":"signal:4e372272-f970-48c5-8a27-aca26bba759c:pricing-page-visited:2026-07-01T11:00:00.000Z"}}',NULL,'2026-08-09T07:05:56.344Z','2026-08-09T07:05:56.345Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('a841e758-6f8a-4c83-8bd4-50beb8ba9584','lead.enrich','completed','{"recordId":"4e372272-f970-48c5-8a27-aca26bba759c","input":{"provider":"fixture-firmographics"},"actor":{"type":"user","id":"legacy-operator"}}','{"reused":false,"snapshot":{"id":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","provider":"fixture-firmographics","providerVersion":1,"providerFingerprint":"f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1","sourceKey":"enrich:4e372272-f970-48c5-8a27-aca26bba759c:fixture-firmographics@1:1","status":"partial","country":null,"language":null,"employeeRange":null,"confidence":40,"retrievedAt":"2026-08-09T07:05:56.347Z","expiresAt":"2026-09-08T07:05:56.347Z"},"lead":{"id":"4e372272-f970-48c5-8a27-aca26bba759c","enrichmentSnapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","enrichedAt":"2026-08-09T07:05:56.349Z"}}',NULL,'2026-08-09T07:05:56.347Z','2026-08-09T07:05:56.351Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('eb53c130-ba98-4875-a2e4-7db6705b10c0','lead.score','completed','{"recordId":"4e372272-f970-48c5-8a27-aca26bba759c","input":{"model":"b2b-saas-score","version":1},"actor":{"type":"user","id":"legacy-operator"}}','{"runId":"4d86662c-8f0d-4b4e-893c-88073f9b4871","model":"b2b-saas-score","version":1,"fingerprint":"ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda","total":35,"snapshotId":"051dd3e0-b2b3-4127-905f-27e89d4e6a2e","signalCount":2,"contributions":[{"ruleKey":"enterprise-company","label":"Enterprise company size","matched":false,"contribution":0,"reason":"no enterprise employee range"},{"ruleKey":"supported-country","label":"Company in a supported country","matched":false,"contribution":0,"reason":"no supported country evidence"},{"ruleKey":"demo-requested","label":"Requested a demo","matched":true,"contribution":25,"reason":null},{"ruleKey":"pricing-page-visited","label":"Visited the pricing page","matched":true,"contribution":10,"reason":null},{"ruleKey":"highly-engaged","label":"Highly engaged (declared signal-count threshold)","matched":false,"contribution":0,"reason":null},{"ruleKey":"missing-company-name","label":"No company name on the lead","matched":false,"contribution":0,"reason":null}],"lead":{"id":"4e372272-f970-48c5-8a27-aca26bba759c","score":35,"scoreRunId":"4d86662c-8f0d-4b4e-893c-88073f9b4871"}}',NULL,'2026-08-09T07:05:56.354Z','2026-08-09T07:05:56.359Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('b99a9316-2fea-4ea9-bea2-81ad409afa2d','lead.route','completed','{"recordId":"4e372272-f970-48c5-8a27-aca26bba759c","input":{"policy":"b2b-sales-routing","version":1},"actor":{"type":"user","id":"legacy-operator"}}','{"runId":"f4dc8b8f-b52d-4ff3-82e5-89eef09e4da8","assignmentId":"f007ee75-43ba-48bf-b4e8-471286c1807c","policy":"b2b-sales-routing","version":1,"fingerprint":"2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2","targetsFingerprint":"dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963","target":{"key":"unrouted-queue","kind":"fallback","label":"Unrouted (needs human triage)"},"matchedRule":null,"fallbackReason":"policy declined all eligible targets","evaluatedTargets":3,"eligibleTargets":2,"lead":{"id":"4e372272-f970-48c5-8a27-aca26bba759c","assignedTargetId":"unrouted-queue","assignedAt":"2026-08-09T07:05:56.362Z"}}',NULL,'2026-08-09T07:05:56.361Z','2026-08-09T07:05:56.366Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('8a3b91b3-387e-4475-b918-d8d254d4c6b3','lead.record-signal','completed','{"recordId":"6c94d389-d956-40a5-83b0-05d9260c0b23","input":{"signalType":"demo-requested","observedAt":"2026-07-01T10:00:00.000Z"},"actor":{"type":"user","id":"legacy-operator"}}','{"signal":{"id":"d39cb769-9181-4dba-80e8-8469f8579172","signalType":"demo-requested","observedAt":"2026-07-01T10:00:00.000Z","sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:demo-requested:2026-07-01T10:00:00.000Z"}}',NULL,'2026-08-09T07:05:56.368Z','2026-08-09T07:05:56.369Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('d6f49570-0d7c-488c-8abe-5a686f6b746d','lead.record-signal','completed','{"recordId":"6c94d389-d956-40a5-83b0-05d9260c0b23","input":{"signalType":"pricing-page-visited","observedAt":"2026-07-01T11:00:00.000Z"},"actor":{"type":"user","id":"legacy-operator"}}','{"signal":{"id":"773749e1-4053-4f7f-b846-56a7aee799dd","signalType":"pricing-page-visited","observedAt":"2026-07-01T11:00:00.000Z","sourceKey":"signal:6c94d389-d956-40a5-83b0-05d9260c0b23:pricing-page-visited:2026-07-01T11:00:00.000Z"}}',NULL,'2026-08-09T07:05:56.371Z','2026-08-09T07:05:56.372Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('d3001d20-5aae-41a8-9f65-e7ff18ed5e17','lead.enrich','completed','{"recordId":"6c94d389-d956-40a5-83b0-05d9260c0b23","input":{"provider":"fixture-firmographics"},"actor":{"type":"user","id":"legacy-operator"}}','{"reused":false,"snapshot":{"id":"fd694748-6270-4262-9873-695f077db97f","provider":"fixture-firmographics","providerVersion":1,"providerFingerprint":"f015b7da36f2461af86e1467a836869cdcb1235c3a2a89b2fbb4b81c7025b3d1","sourceKey":"enrich:6c94d389-d956-40a5-83b0-05d9260c0b23:fixture-firmographics@1:1","status":"partial","country":null,"language":null,"employeeRange":null,"confidence":40,"retrievedAt":"2026-08-09T07:05:56.375Z","expiresAt":"2026-09-08T07:05:56.375Z"},"lead":{"id":"6c94d389-d956-40a5-83b0-05d9260c0b23","enrichmentSnapshotId":"fd694748-6270-4262-9873-695f077db97f","enrichedAt":"2026-08-09T07:05:56.375Z"}}',NULL,'2026-08-09T07:05:56.374Z','2026-08-09T07:05:56.377Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('834d06ae-6d62-4fba-bfea-4924440372bb','lead.score','completed','{"recordId":"6c94d389-d956-40a5-83b0-05d9260c0b23","input":{"model":"b2b-saas-score","version":1},"actor":{"type":"user","id":"legacy-operator"}}','{"runId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c","model":"b2b-saas-score","version":1,"fingerprint":"ced810d846cf46a8f33e6462004d88c343a273c278d668cae69d09f1f85aabda","total":35,"snapshotId":"fd694748-6270-4262-9873-695f077db97f","signalCount":2,"contributions":[{"ruleKey":"enterprise-company","label":"Enterprise company size","matched":false,"contribution":0,"reason":"no enterprise employee range"},{"ruleKey":"supported-country","label":"Company in a supported country","matched":false,"contribution":0,"reason":"no supported country evidence"},{"ruleKey":"demo-requested","label":"Requested a demo","matched":true,"contribution":25,"reason":null},{"ruleKey":"pricing-page-visited","label":"Visited the pricing page","matched":true,"contribution":10,"reason":null},{"ruleKey":"highly-engaged","label":"Highly engaged (declared signal-count threshold)","matched":false,"contribution":0,"reason":null},{"ruleKey":"missing-company-name","label":"No company name on the lead","matched":false,"contribution":0,"reason":null}],"lead":{"id":"6c94d389-d956-40a5-83b0-05d9260c0b23","score":35,"scoreRunId":"98fd752f-2f5c-4fb4-8748-8dec7ce9696c"}}',NULL,'2026-08-09T07:05:56.381Z','2026-08-09T07:05:56.383Z');
INSERT INTO "workflow_runs" ("id","workflow_name","status","input_json","output_json","error","started_at","finished_at") VALUES ('413d3863-a55a-4253-8f85-f917b2677593','lead.route','completed','{"recordId":"6c94d389-d956-40a5-83b0-05d9260c0b23","input":{"policy":"b2b-sales-routing","version":1},"actor":{"type":"user","id":"legacy-operator"}}','{"runId":"e0aaf94e-f00f-48dc-b20e-addc2baf3ae7","assignmentId":"47434b36-6e08-4b88-8812-4ebdd59ecfae","policy":"b2b-sales-routing","version":1,"fingerprint":"2327771591326c4b5a2c19b900a554845d80879ea1f094c3820bff4400fc40e2","targetsFingerprint":"dda60eb42c7bc677198465e74691764e4bc296fbc14c27a8075e48892e3e6963","target":{"key":"unrouted-queue","kind":"fallback","label":"Unrouted (needs human triage)"},"matchedRule":null,"fallbackReason":"policy declined all eligible targets","evaluatedTargets":3,"eligibleTargets":2,"lead":{"id":"6c94d389-d956-40a5-83b0-05d9260c0b23","assignedTargetId":"unrouted-queue","assignedAt":"2026-08-09T07:05:56.386Z"}}',NULL,'2026-08-09T07:05:56.386Z','2026-08-09T07:05:56.389Z');
COMMIT;
