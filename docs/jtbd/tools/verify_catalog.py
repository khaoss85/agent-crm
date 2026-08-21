#!/usr/bin/env python3
from pathlib import Path
import collections, hashlib, json, sys
ROOT=Path(__file__).resolve().parents[1]
expected={
 'catalog/jtbd.jsonl':('c771e3c6b113903d5dc6e35dad6e793e345106e256aea586fedd062b3a611c28',4611152),
 'MASTER.md':('85a9bfa2460446b54a966a0606a9a199e4d02083268c33fe06826a7e9732e58a',370072),
 'catalog/personas.json':('c7f7c1107f3ceefcaa4cbbcbb08e2a39efd4e6058cf92187b60f967e362cb6b1',36664),
 'catalog/capabilities.json':('8b31c747a648dd0b8d40036baa0331810bb9d4fd1e533b667f674a40c5f365ae',104627),
 'catalog/e2e_scenarios.json':('7c7f3bfcbd7f59e42604ad5f5de4e30c58e858466740cd8c73e890889381b1fb',25314),
}
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
if errors:
 print('VALIDATION_FAILED')
 for e in errors: print('-',e)
 sys.exit(1)
print('VALIDATION_OK')
print('personas=30 capabilities=225 jtbd=600 e2e_scenarios=10')
