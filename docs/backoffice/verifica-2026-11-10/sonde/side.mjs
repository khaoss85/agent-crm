import { launch, serve } from './cdp.mjs';
const server = await serve(); const port = server.address().port; const b = await launch();
for (const name of ['clienti','pipeline']) {
  await b.viewport(390, 844, false);
  await b.goto(`http://127.0.0.1:${port}/m-${name}.html`, `${name}-ready`);
  await new Promise(r=>setTimeout(r,300));
  const r = await b.eval(`(()=>{ scrollTo(10000,0); return { scrollX, scrollWidth: document.documentElement.scrollWidth }; })()`);
  console.log(name, JSON.stringify(r));
  await new Promise(r=>setTimeout(r,200));
  await b.shot(`${process.env.OUT}/finding-${name}-390-scorrimento-laterale.png`);
}
b.close(); server.close();
