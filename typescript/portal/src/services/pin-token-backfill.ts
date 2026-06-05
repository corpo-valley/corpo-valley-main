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
// Step 3's canonical content lives below as a string constant — it's a
// verbatim copy of community-center/.gitea/workflows/build.yaml. Keep
// the two in sync when you change either.

import { Pool } from 'pg';
import { setActionsSecret, upsertRepoFile, getFile } from './gitea';
import { generatePinToken, hashPinToken } from './pin-token';

const databaseUrl = process.env.DATABASE_URL || 'postgres://portal:portal@localhost:5432/portal';
const pool = new Pool({ connectionString: databaseUrl });

const CANONICAL_BUILD_WORKFLOW = `# Corpo Valley — pre-baked container build + manifest pin.
#
# Every push to \`main\` produces an immutable image tag YYYYMMDDHHMMSS
# (the build timestamp). The workflow pushes that tag plus the short
# commit SHA to the in-cluster registry, then calls the Corpo Valley
# portal (in-cluster URL: portal.cv-portal.svc.cluster.local) to pin
# k8s/deployment.yaml to the new timestamp. The portal performs the
# git commit as the platform user, so the workflow doesn't need any
# push credentials or repo write access.
#
# You shouldn't need to edit this — it's the platform's standard
# pipeline.
name: Build
on:
  push:
    branches: [main]

env:
  REGISTRY: registry.cv-registry.svc.cluster.local:5000
  PORTAL_PIN_URL: http://portal.cv-portal.svc.cluster.local/internal/projects

jobs:
  build:
    runs-on: ubuntu-latest
    # Skip the platform's image-pin bump (which carries \`[skip ci]\`).
    if: \${{ !contains(github.event.head_commit.message, '[skip ci]') }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Compute tag
        id: tag
        run: |
          TAG=$(date -u +%Y%m%d%H%M%S)
          SHA=$(git rev-parse --short HEAD)
          FULL_SHA=$(git rev-parse HEAD)
          IMAGE="$REGISTRY/\${{ github.repository }}"
          echo "tag=$TAG"           >> "$GITHUB_OUTPUT"
          echo "sha=$SHA"           >> "$GITHUB_OUTPUT"
          echo "full_sha=$FULL_SHA" >> "$GITHUB_OUTPUT"
          echo "image=$IMAGE"       >> "$GITHUB_OUTPUT"

      - name: Build and push image
        run: |
          IMAGE="\${{ steps.tag.outputs.image }}"
          TAG="\${{ steps.tag.outputs.tag }}"
          SHA="\${{ steps.tag.outputs.sha }}"
          docker build -t "$IMAGE:$TAG" -t "$IMAGE:$SHA" .
          docker push "$IMAGE:$TAG"
          docker push "$IMAGE:$SHA"
          echo "Pushed $IMAGE:$TAG and $IMAGE:$SHA"

      - name: Ask portal to pin the Deployment
        # The portal writes the bump commit as the platform user, so the
        # workflow itself doesn't need git push credentials. CV_PIN_TOKEN
        # is a per-project secret minted by the platform at project
        # create time; it authenticates this specific project's workflow
        # to the portal's pin endpoint (which would otherwise be
        # cross-project-reachable from any runner). The portal also
        # cross-checks the supplied SHA against the current head of
        # main, refusing if they don't match.
        env:
          CV_PIN_TOKEN: \${{ secrets.CV_PIN_TOKEN }}
        run: |
          SLUG="\${{ github.event.repository.name }}"
          TAG="\${{ steps.tag.outputs.tag }}"
          SHA="\${{ steps.tag.outputs.full_sha }}"
          curl -fsS -X POST \\
            -H "Authorization: Bearer $CV_PIN_TOKEN" \\
            -H 'Content-Type: application/json' \\
            -d "{\\"tag\\":\\"$TAG\\",\\"sha\\":\\"$SHA\\"}" \\
            "$PORTAL_PIN_URL/$SLUG/pin"
`;

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
        await upsertRepoFile({
          owner, repo,
          path: '.gitea/workflows/build.yaml',
          content: CANONICAL_BUILD_WORKFLOW,
          sha: existing?.sha,
          message: 'platform: enable CV_PIN_TOKEN auth on pin endpoint',
        });
      }
      console.log(`[pin-token] backfilled ${row.slug}`);
    } catch (err: any) {
      console.error(`[pin-token] backfill failed for ${row.slug}:`, err?.message);
      // Best-effort: a single failure doesn't abort the rest.
    }
  }
}
