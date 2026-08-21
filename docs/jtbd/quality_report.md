# JTBD catalog quality report

Catalog-specific validation result: `VALIDATION_OK`.

```text
personas=30 capabilities=225 jtbd=600
phase_counts= {'ADOPT': 120, 'RUN': 240, 'OPTIMIZE': 120, 'MAINTAIN': 30, 'GOVERN': 30, 'EVOLVE': 60}
risk_counts= {'MEDIUM': 284, 'LOW': 193, 'HIGH': 123}
VALIDATION_OK
```

Structural checks on the recovered source corpus:

- 30 personas.
- 600 unique JTBD records.
- Exactly 20 JTBD per persona.
- 225 known capability IDs.
- Zero unknown capability references.
- 10 end-to-end scenarios.
- Every persona contains ADOPT, RUN, OPTIMIZE, MAINTAIN, GOVERN and EVOLVE records.
- Every shipped portable catalog coverage record is initialized as `NOT_ASSESSED`.
- XZ source and decompressed byte lengths/SHA-256 match `manifest.json`.

The original generated workbook was also opened successfully during source-package validation, but the workbook is **not checked into this repository** and is not required for Phase D.

This report validates catalog integrity only. It makes no claim about current Accordo product coverage, repository health, CI or production readiness.
