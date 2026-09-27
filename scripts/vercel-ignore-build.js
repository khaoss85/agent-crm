// @ts-check

/**
 * Refuses the Vercel build for deployments nobody asked for.
 *
 * Wired as `ignoreCommand` in vercel.json. Vercel's contract is inverted
 * relative to the usual one, and the two exits below are the whole API:
 *   exit 1 = PROCEED with the build
 *   exit 0 = SKIP the build (the deployment is marked "skipped")
 *
 * Direction is FAIL-SAFE TO BUILD. Every state this file does not positively
 * recognise — production, an unset `VERCEL_ENV`, a branch with no prefix, a
 * missing variable — exits 1, because publishing a site one build later than
 * necessary costs a minute and publishing it one build too few republishes a
 * page whose claims have moved.
 *
 * ── Why this is the SECOND line of defence ────────────────────────────────
 * `git.deploymentEnabled` in vercel.json already refuses to create a
 * deployment at all for the same branch prefixes. That is the line that saves
 * the money, because a skipped build is not a free build:
 *
 *   Vercel bills builds at $0.0035 per CPU-minute, with the wall-clock
 *   duration ROUNDED UP to the whole minute and multiplied by the machine's
 *   core count (https://vercel.com/docs/pricing#builds). On an Enhanced
 *   machine — 8 cores — the floor for any deployment that reaches a build
 *   container is 1 min x 8 x $0.0035 = $0.028, even for a build this file
 *   refuses in under a second. A branch that receives thirty pushes therefore
 *   costs $0.84 to skip and nothing at all to never deploy.
 *
 * This file exists for the deployments `deploymentEnabled` cannot see: a
 * manual "Redeploy" from the dashboard, a `vercel deploy` from a CLI, or a
 * branch prefix a future change adds here and forgets there. Keep the list
 * below and the one in vercel.json in step — they are the same policy stated
 * at two different moments, before the container exists and inside it.
 *
 * Want a real preview of an agent branch? Push the same commits under a
 * branch name matching none of these prefixes. That path stays open on
 * purpose, and it is billed on purpose.
 */

const AGENT_BRANCH_PREFIXES = ['claude/', 'agent/', 'codex/', 'worktree-'];

const env = process.env.VERCEL_ENV ?? '';
const ref = process.env.VERCEL_GIT_COMMIT_REF ?? '';

if (env === 'preview' && AGENT_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix))) {
  console.log(`vercel-ignore-build: agent preview build for ${ref} -> SKIP`);
  process.exit(0);
}

console.log(`vercel-ignore-build: env=${env || '(unset)'} ref=${ref || '(unset)'} -> BUILD`);
process.exit(1);
