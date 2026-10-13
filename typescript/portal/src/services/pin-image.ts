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
// Only lines on the in-cluster registry host match: the postgres StatefulSet's
// `image: postgres:16-alpine` is left alone. The `g` flag pins ALL matching
// container lines — a multi-capability project runs several containers from
// the same image and they must move together.
export function rewritePinnedImageLines(
  content: string,
  target: { owner: string; repo: string; tag: string },
): string {
  const path = `${target.owner}/${target.repo}`;
  return content.replace(
    /^(\s*image:\s+registry\.cv-registry[^/\s]*)\/[^\s:]+:[A-Za-z0-9_.-]+$/mg,
    (_m, host: string) => `${host}/${path}:${target.tag}`,
  );
}
