import { launch, serve, MEASURE } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT; mkdirSync(OUT, { recursive: true });
const screens = (process.env.SCREENS ?? 'oggi,clienti,cliente,calendario,pipeline,personalizzazione').split(',');
const server = await serve(); const port = server.address().port;
const b = await launch();
const results = {};
try {
  for (const name of screens) {
    for (const [w, h, phone] of [[390, 844, true], [1440, 1800, false]]) {
      await b.viewport(w, h, phone);
      await b.goto(`http://127.0.0.1:${port}/m-${name}.html`, `${name}-ready`);
      await new Promise((r) => setTimeout(r, 400));
      const m = await b.eval(MEASURE(w));
      if (!m.ok) { process.exitCode = 1; console.log('FAIL', name, w, m.failures.join('; ')); }
      results[`${name}@${w}`] = m;
      await b.shot(`${OUT}/${name}-${w}-viewport.png`);
      console.log(name, w, JSON.stringify({ ok: m.ok, failures: m.failures, innerWidth: m.innerWidth, docScrollWidth: m.docScrollWidth, vw: m.vw, overflow: m.horizontalOverflowPx, offenders: m.offenders, contentTop: m.contentTop, vmTop: m.viewModuleTop, topbarH: m.topbar?.h, crumb: m.crumb, minField: m.minFieldFontPx, under16: m.fieldsUnder16 }));
    }
  }
} finally { b.close(); server.close(); }
writeFileSync(`${OUT}/layout-measures.json`, JSON.stringify(results, null, 2));
