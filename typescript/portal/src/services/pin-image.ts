import { CV_REGISTRY } from './platform-config';

// The pin rewrite for k8s/deployment.yaml, as a pure function so it is unit
// testable without Gitea.
//
// Every `image: registry.cv-registry.../<owner>/<repo>:<tag>` line is rewritten
// to `<same host>/<owner>/<repo>:<tag>` — the OWNER/REPO path as well as the
// tag. The Build workflow pushes to `$REGISTRY/${{ github.repository }}`, so
// after an admin transfers a project to a new owner the next build lands
// under `<newOwner>/<slug>`; a tag-only rewrite would keep the committed
// `<oldOwner>/<slug>` path and pin a tag that was never pushed there
// (ImagePullBackOff on the first post-transfer build). Rewriting the path from
// the project row (the source of truth for the repo's current owner) makes the
// first post-transfer build converge on its own.
//
// Only lines on the configured in-cluster registry host match: the postgres StatefulSet's
// `image: postgres:16-alpine` is left alone. The `g` flag pins ALL matching
// container lines — a multi-capability project runs several containers from
// the same image and they must move together.
export function rewritePinnedImageLines(
  content: string,
  target: { owner: string; repo: string; tag: string },
  // The in-cluster registry host (with port) the project images live on.
  // Anchored on the configured value rather than a hard-coded `registry.cv-registry`
  // so a deployment with another namespacePrefix / registry still pins.
  registry: string = CV_REGISTRY,
): string {
  const path = `${target.owner}/${target.repo}`;
  const host = registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Path class excludes `@` so digest-pinned lines (`…/foo@sha256:…`) are left
  // alone, matching projectImageLineRe() in services/manifests.ts.
  const re = new RegExp(`^(\\s*image:\\s+${host})\\/[^\\s:@]+:[A-Za-z0-9_.-]+$`, 'mg');
  return content.replace(re, (_m, prefix: string) => `${prefix}/${path}:${target.tag}`);
}
