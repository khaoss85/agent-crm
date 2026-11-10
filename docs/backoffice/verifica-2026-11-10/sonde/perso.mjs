import { launch, serve, MEASURE } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
const server = await serve(); const port = server.address().port; const b = await launch();
const out = {};
for (const [w,h,phone] of [[390,844,true],[1440,1800,false]]) {
  await b.viewport(w,h,phone);
  await b.goto(`http://127.0.0.1:${port}/m-personalizzazione.html`, 'personalizzazione-ready');
  await new Promise(r=>setTimeout(r,400));
  const r = await b.eval(`(() => {
    const vm = document.getElementById('view-module');
    const vis = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
    const txt = (sel) => [...vm.querySelectorAll(sel)].filter(vis).map(n => n.textContent.trim().replace(/\\s+/g,' ')).filter(Boolean);
    const has = (t) => [...vm.querySelectorAll('*')].some(n => vis(n) && n.children.length === 0 && n.textContent.trim().replace(/\\s+/g,' ').includes(t)) || [...vm.querySelectorAll('button, a, [role=tab], input')].some(n => vis(n) && ((n.textContent||'') + ' ' + (n.getAttribute('placeholder')||'') + ' ' + (n.getAttribute('aria-label')||'')).includes(t));
    const checks = {};
    for (const t of ['Skill AI','Connettori','Pacchetti','I tuoi','Scopri','Cerca','+ Aggiungi','Curato da Accordo','Kit social','Esplora','Canali di conversazione','Agenda, lead e pagamenti','Mostra tutto']) checks[t] = has(t);
    const tabs = txt('[role=tab], .ui-tabs button, .bo-perso-tabs button').slice(0,6);
    const kit = [...vm.querySelectorAll('*')].filter(n => vis(n) && n.children.length===0 && /^(IG|FB|TT|WA)$/.test(n.textContent.trim())).map(n=>n.textContent.trim());
    const old = { ordinaNome: has('Ordina: nome'), noveVoci: has('9 voci'), rigaVecchia: has('Collega i canali una volta sola') };
    const dots = vm.querySelectorAll('[class*=dot]').length;
    const arrows = [...vm.querySelectorAll('button')].filter(n => vis(n) && /^[‹›←→<>]$/.test(n.textContent.trim())).map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; });
    const cards = [...vm.querySelectorAll('.ui-conn-card, [class*=conn-card]')].filter(vis).map(n => n.querySelector('h3,h4,strong,.name')?.textContent.trim()).filter(Boolean).slice(0,10);
    return { checks, tabs, kit, old, dots, arrows, cards };
  })()`);
  r.layout = (({ vw, horizontalOverflowPx, contentTop, minFieldFontPx }) => ({ vw, horizontalOverflowPx, contentTop, minFieldFontPx }))(await b.eval(MEASURE));
  out[w] = r; console.log(w, JSON.stringify(r));
  await b.shot(`${process.env.OUT}/personalizzazione-${w}-intera.png`, true);
}
writeFileSync(`${process.env.OUT}/personalizzazione-measures.json`, JSON.stringify(out, null, 2));
b.close(); server.close();
