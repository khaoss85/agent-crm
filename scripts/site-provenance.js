// @ts-check
import { execFileSync } from 'node:child_process';

/**
 * Resolve the source commit from Git itself. Deployment environment SHAs are intentionally ignored:
 * they are useful assertions, not authorities over the bytes checked out. Only a no-Git test fixture
 * may inject a full SHA through the explicitly test-only variable.
 * @param {{cwd:string, env?:NodeJS.ProcessEnv}} input
 */
export function checkoutSha({ cwd, env = process.env }) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    const fixtureSha = env.ACCORDO_SITE_TEST_CHECKOUT_SHA;
    if (env.NODE_ENV === 'test' && /^[0-9a-f]{40}$/i.test(String(fixtureSha))) return String(fixtureSha);
    throw new Error('site-build requires a Git checkout; only an isolated NODE_ENV=test fixture may inject ACCORDO_SITE_TEST_CHECKOUT_SHA');
  }
}
