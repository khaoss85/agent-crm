// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Human product pages whose canonical HTML is also published as generated Markdown.
 * One list is shared by the builder, the honesty gate, tests and llms discovery so a
 * newly strategic page cannot silently miss the machine-readable half of its contract.
 */
export const STRATEGIC_PAGES = Object.freeze([
  'index.html',
  'product.html',
  'solutions.html',
  'solution-custom-crm.html',
  'solution-revenue-operations.html',
  'solution-commercial-operations.html',
  'solution-service-operations.html',
  'how-it-works.html',
  'developers.html',
  'for-ai-agents.html',
  'proof.html',
  'resources.html',
]);

/** @param {string} htmlPath */
export function markdownPath(htmlPath) {
  return htmlPath.replace(/\.html$/, '.md');
}

/** @param {{outDir:string, origin:string}} input */
export function inspectStrategicSurfaces({ outDir, origin }) {
  const problems = [];
  for (const page of STRATEGIC_PAGES) {
    const htmlPath = join(outDir, page);
    const mdName = markdownPath(page);
    const mdPath = join(outDir, mdName);
    if (!existsSync(htmlPath)) {
      problems.push(`site/dist/${page}: strategic canonical HTML is missing`);
      continue;
    }
    if (!existsSync(mdPath)) {
      problems.push(`site/dist/${mdName}: strategic Markdown equivalent is missing`);
      continue;
    }
    const expectedCanonical = page === 'index.html' ? `${origin}/` : `${origin}/${page}`;
    const expectedAlternate = `${origin}/${mdName}`;
    const html = readFileSync(htmlPath, 'utf8');
    if (!html.includes(`<link rel="canonical" href="${expectedCanonical}" />`)) {
      problems.push(`site/dist/${page}: canonical does not identify the strategic HTML page`);
    }
    if (!html.includes(`<link rel="alternate" type="text/markdown" href="${expectedAlternate}" title="Markdown equivalent" />`)) {
      problems.push(`site/dist/${page}: Markdown alternate is missing or points somewhere other than ${expectedAlternate}`);
    }
    if (!readFileSync(mdPath, 'utf8').includes(`Canonical: ${expectedCanonical}`)) {
      problems.push(`site/dist/${mdName}: generated Markdown does not point back to canonical HTML ${expectedCanonical}`);
    }
  }
  return problems;
}
