// @ts-check
// Public-site only. No npm dependency or generated CRM instrumentation.
// Vercel's static queue / beforeSend API: https://vercel.com/docs/analytics/package
(() => {
  const script = document.currentScript;
  const page = script?.getAttribute('data-page');
  if (!page) return;
  const canonical = new URL(page);
  // Keep previews, localhost and saved HTML out of the production statistics.
  if (location.origin !== canonical.origin) return;
  const disabled = () => navigator.doNotTrack === '1'
    || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  if (disabled()) return;

  // The hosted collector includes external document.referrer independently of
  // beforeSend. Refuse collection if that value could contain a path or query.
  // Normal cross-origin links supply only an origin under modern browser policy.
  if (document.referrer) {
    try {
      const referrer = new URL(document.referrer);
      if (referrer.origin !== location.origin
        && (referrer.pathname !== '/' || referrer.search || referrer.hash
          || referrer.username || referrer.password)) return;
    } catch { return; }
  }

  const events = new Set(['tutorial_open', 'example_open', 'quickstart_open']);
  const sources = new Set(['dev', 'hashnode', 'skills', 'gemini', 'smithery']);
  const query = new URL(location.href).searchParams;
  const source = query.get('utm_source');
  const campaign = query.get('utm_campaign');
  const attribution = sources.has(source)
    && campaign === 'quote-approval' ? { source, campaign_id: 'quote-approval' } : undefined;

  window.va = window.va || function () {
    (window.vaq = window.vaq || []).push(arguments);
  };
  window.va('beforeSend', (event) => {
    if (disabled()) return null;
    if (event.type === 'pageview') return { type: 'pageview', url: canonical.href };
    if (event.type !== 'event' || !events.has(event.payload?.name)) return null;
    // Reconstruct our CTA payload; this hook is not a sandbox for other scripts.
    // Vercel also exposes route/flag APIs, which this integration never calls.
    return { type: 'event', url: canonical.href,
      payload: { name: event.payload.name, ...(attribution ? { data: attribution } : {}) } };
  });

  document.addEventListener('click', (event) => {
    if (disabled()) return;
    const target = event.target?.closest?.('[data-site-event]');
    const name = target?.getAttribute('data-site-event');
    if (events.has(name)) window.va('event', { name, ...(attribution ? { data: attribution } : {}) });
  });
  const collector = document.createElement('script');
  collector.defer = true;
  collector.src = '/_vercel/insights/script.js';
  collector.referrerPolicy = 'no-referrer';
  document.head.appendChild(collector);
})();
