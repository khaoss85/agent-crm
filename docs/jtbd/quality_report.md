# Quality report

## Result

`VALIDATION_OK`

```text
personas=30 capabilities=225 jtbd=600
phase_counts= {'ADOPT': 120, 'RUN': 240, 'OPTIMIZE': 120, 'MAINTAIN': 30, 'GOVERN': 30, 'EVOLVE': 60}
risk_counts= {'MEDIUM': 284, 'LOW': 193, 'HIGH': 123}
VALIDATION_OK
```

## Structural checks

- Personas: 30.
- JTBD: 600.
- Exactly 20 JTBD per persona: yes.
- Capabilities: 225.
- Unknown capability references: 0.
- Duplicate JTBD IDs: 0.
- End-to-end scenarios: 10.
- Workbook reopened successfully: yes.
- JTBD workbook rows: 600.
- Canonical catalog coverage initialized as `NOT_ASSESSED`: yes.

## Lifecycle distribution

| Phase | Count |
|---|---:|
| ADOPT | 120 |
| EVOLVE | 60 |
| GOVERN | 30 |
| MAINTAIN | 30 |
| OPTIMIZE | 120 |
| RUN | 240 |

## Risk distribution

| Risk | Count |
|---|---:|
| HIGH | 123 |
| LOW | 193 |
| MEDIUM | 284 |

## Persona lifecycle invariant

Each persona contains ADOPT, RUN, OPTIMIZE, MAINTAIN, GOVERN and EVOLVE records. This is validated by `tools/verify_catalog.py`.

## Caveat

This report validates catalog integrity, not current product coverage. Repository coverage requires a target repository and SHA.
