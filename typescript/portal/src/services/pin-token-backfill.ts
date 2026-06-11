// One-shot backfill for the CV_PIN_TOKEN auth on POST
// /internal/projects/:slug/pin. Runs on portal startup; idempotent.
//
// For each project with a Gitea repo but no pin_token_hash:
//   1. mint a fresh token, store sha256(token) in the projects row,
//   2. set the plaintext as a Gitea Actions secret named CV_PIN_TOKEN
//      on the project's repo,
//   3. upsert the project's .gitea/workflows/build.yaml so the workflow
//      actually sends the Bearer header. Without this, existing
//      projects' next push 401s at the pin endpoint and the Deployment
//      never advances.
//
// Step 3's content comes from the baked-in community-center baseline
// (rendered with this deployment's registry/portal URLs by
// template-seed.ts) — the same canonical source the template seed
// pushes to Gitea, so the two can't drift.

import { Pool } from 'pg';
import { setActionsSecret, upsertRepoFile, getFile } from './gitea';
import { generatePinToken, hashPinToken } from './pin-token';
import { resolveDatabaseUrl } from './projects';
import { renderedBaselineFile } from './template-seed';

// Fail closed in production if DATABASE_URL is unset rather than using the
// built-in portal:portal default — see resolveDatabaseUrl in projects.ts.
const pool = new Pool({ connectionString: resolveDatabaseUrl() });


export async function backfillPinTokens(): Promise<void> {
  const { rows } = await pool.query<{
    id: string; slug: string; gitea_repo: string | null; pin_token_hash: string | null;
  }>(
    `SELECT id, slug, gitea_repo, pin_token_hash
     FROM projects
     WHERE gitea_repo IS NOT NULL AND pin_token_hash IS NULL`
  );
  if (rows.length === 0) return;
  console.log(`[pin-token] backfilling ${rows.length} project(s)`);

  for (const row of rows) {
    try {
      const [owner, repo] = (row.gitea_repo as string).split('/');
      const token = generatePinToken();
      const hash = hashPinToken(token);
      await pool.query('UPDATE projects SET pin_token_hash = $2 WHERE id = $1', [row.id, hash]);
      await setActionsSecret({ owner, repo, name: 'CV_PIN_TOKEN', data: token });

      // Refresh build.yaml so the workflow actually USES the new secret.
      // Skip if the existing file already references CV_PIN_TOKEN (don't
      // overwrite hand-edits the user may have made post-template).
      const existing = await getFile({ owner, repo, path: '.gitea/workflows/build.yaml' }).catch(() => null);
      if (existing && existing.content.includes('CV_PIN_TOKEN')) {
        console.log(`[pin-token] ${row.slug}: workflow already references CV_PIN_TOKEN, skipping file write`);
      } else {
        const workflow = renderedBaselineFile('.gitea/workflows/build.yaml');
        if (!workflow) {
          console.error(`[pin-token] ${row.slug}: baseline build.yaml not found on disk — token set, workflow NOT refreshed`);
        } else {
          await upsertRepoFile({
            owner, repo,
            path: '.gitea/workflows/build.yaml',
            content: workflow,
            sha: existing?.sha,
            message: 'platform: enable CV_PIN_TOKEN auth on pin endpoint',
          });
        }
      }
      console.log(`[pin-token] backfilled ${row.slug}`);
    } catch (err: any) {
      console.error(`[pin-token] backfill failed for ${row.slug}:`, err?.message);
      // Best-effort: a single failure doesn't abort the rest.
    }
  }
}
