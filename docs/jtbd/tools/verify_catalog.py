#!/usr/bin/env python3
from pathlib import Path
import collections, hashlib, json, sys
ROOT=Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'manifest.json').read_text())
expected={entry['path']:(entry['sha256'],entry['bytes']) for entry in manifest['files']}
errors=[]
for rel,(sha,n) in expected.items():
 p=ROOT/rel
 if not p.exists(): errors.append(f'MISSING {rel}'); continue
 b=p.read_bytes()
 if len(b)!=n: errors.append(f'BYTES {rel}: {len(b)} != {n}')
 got=hashlib.sha256(b).hexdigest()
 if got!=sha: errors.append(f'SHA256 {rel}: {got} != {sha}')
personas=json.loads((ROOT/'catalog/personas.json').read_text())
caps=json.loads((ROOT/'catalog/capabilities.json').read_text())
scenarios=json.loads((ROOT/'catalog/e2e_scenarios.json').read_text())
records=[]
with (ROOT/'catalog/jtbd.jsonl').open() as f:
 for i,line in enumerate(f,1):
  try: records.append(json.loads(line))
  except Exception as e: errors.append(f'JSON line {i}: {e}')
ids=[r.get('jtbd_id') for r in records]
if len(records)!=600: errors.append(f'JTBD count {len(records)} != 600')
if len(set(ids))!=len(ids): errors.append('duplicate jtbd_id')
# tolerate package shapes: list or wrapped object
def seq(x,*keys):
 if isinstance(x,list): return x
 for k in keys:
  if isinstance(x,dict) and isinstance(x.get(k),list): return x[k]
 return []
pers=seq(personas,'personas','items')
capl=seq(caps,'capabilities','items')
scen=seq(scenarios,'scenarios','e2e_scenarios','items')
if len(pers)!=30: errors.append(f'persona count {len(pers)} != 30')
if len(capl)!=225: errors.append(f'capability count {len(capl)} != 225')
if len(scen)!=10: errors.append(f'scenario count {len(scen)} != 10')
by_persona=collections.Counter(r.get('persona_id') or r.get('role_id') for r in records)
# There must be 30 non-null persona/role keys with 20 jobs each.
if len(by_persona)!=30 or set(by_persona.values())!={20}: errors.append(f'jobs/persona invalid: {dict(by_persona)}')
# v1.1 semantic invariants and retirement resolution.
for record in records:
 autonomy=record.get('agentic_design',{})
 if autonomy.get('target_autonomy')=='L3' and autonomy.get('human_approval_required') is not True:
  errors.append(f"L3_APPROVAL_CONTRADICTION {record.get('jtbd_id')}")
sup_path=ROOT/'catalog/supersessions.json'
if not sup_path.exists(): errors.append('MISSING catalog/supersessions.json')
else:
 supersessions=json.loads(sup_path.read_text())
 active=set(ids)
 for item in supersessions.get('supersededIds',[]):
  old=item.get('id'); replacement=item.get('supersededBy')
  if old in active or not replacement or replacement not in active:
   errors.append(f'SUPERSESSION_UNRESOLVED {old} -> {replacement}')
if errors:
 print('VALIDATION_FAILED')
 for e in errors: print('-',e)
 sys.exit(1)
print('VALIDATION_OK')
print('personas=30 capabilities=225 jtbd=600 e2e_scenarios=10')
