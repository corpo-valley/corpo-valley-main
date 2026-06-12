// Self-documentation surfaced through the `how_corpo_valley_works` MCP tool.
// Agents call this on first use to bootstrap their mental model so a fresh
// conversation doesn't waste turns guessing at the platform.
//
// Keep entries short, concrete, and oriented around what the agent can DO,
// not internal architecture trivia. If you change platform behaviour, edit
// the relevant topic here so an MCP-connected agent learns about it.

export type DocsTopic = 'overview' | 'projects' | 'gitea' | 'pipeline' | 'secrets' | 'deploy' | 'access' | 'kubernetes' | 'database';

import { PROJECTS_DOMAIN, CV_REGISTRY, PORTAL_INTERNAL_URL } from './platform-config';

// Display hosts for the docs, derived from this deployment's config so the
// agent never learns another deployment's URLs. The base domain is the
// projects suffix minus its first label (projects.example.com → example.com);
// the gitea host follows the chart's `gitea.<domain>` default.
const BASE_DOMAIN = PROJECTS_DOMAIN.split('.').slice(1).join('.');
const GITEA_HOST = `gitea.${BASE_DOMAIN}`;
const PORTAL_PIN_HOST = PORTAL_INTERNAL_URL.replace(/^https?:\/\//, '');

const TOPICS: Record<DocsTopic, string> = {
  overview: `# Corpo Valley — overview

Corpo Valley turns "I want to ship a web app" into a few clicks plus a
conversation with you (the agent). Each user owns one or more **projects**.
Each project is composed of up to three **capability modules**:

- **website** (always on) — a static/dynamic site served at \`/\`.
- **database** — a Postgres-backed JSON API at \`/api\`, with per-user data
  isolation by default.
- **mcp** — an MCP endpoint at \`/mcp\` so agents can use the project as a tool.

All three are Node.js, share one \`package.json\` and one \`Dockerfile\`, and
build into one image; the Deployment runs one container per enabled
capability and the Ingress path-routes to them. Every project also gives them:

- A Gitea repository (private by default), generated from the Community
  Center template (which carries all three capability modules).
- A pre-baked CI pipeline (builds the container, runs semgrep and
  osv-scanner, blocks merges on findings).
- An auto-deployed namespace + Ingress at
  \`https://<slug>.${PROJECTS_DOMAIN}\`, gated at the edge by the Kratos
  session check. Every deployed site requires sign-in regardless of visibility.
- Sealed Secrets the user manages through the portal.

Identity: the edge gates every request on a valid Kratos session; the database
and mcp modules re-validate the forwarded session cookie (shared helper) to
identify the caller and scope data by it (per-user by default; \`shared\`
opt-in).

Your role as an MCP-connected agent: drive the code in their repo, ship
features, use \`get_gitea_credentials\` to clone + push, \`set_capabilities\`
to add/remove a database or mcp endpoint, and \`set_project_secret\` for
runtime API keys. \`list_projects\` / \`get_project\` show current state and
enabled capabilities.

Don't write a new CI workflow and don't hand-edit \`k8s/\` — the
\`k8s/{deployment,service,ingress}.yaml\` files are platform-generated from the
capability set. To change capabilities, use \`set_capabilities\` (or the
portal checkboxes); to model a capability by hand, read its pattern with
\`get_template\`.

Platform source lives at https://github.com/corpo-valley/corpo-valley-main
(portal + this MCP server + the mcp gateway) — point the user there for
issues or to read how the platform itself works.
`,
  projects: `# Projects

A project is owned by exactly one Corpo Valley user. The slug is a
DNS-label (\`[a-z0-9-]+\`, ≤63 chars) and uniquely identifies the project
across the platform.

Each project has:
- A Gitea repo at \`${GITEA_HOST}/<owner>/<slug>\`
- An ArgoCD Application in the \`cv-projects-argocd\` namespace deploying
  the repo's \`k8s/\` path to a namespace named after the slug.
- A live URL \`https://<slug>.${PROJECTS_DOMAIN}\`.
- A visibility setting:
  * \`private\`  — repo private, service requires Kratos session (default)
  * \`internal\` — repo visible to other CV members, service still requires
                   Kratos session
  Corpo Valley intentionally has no public tier; both the repo and the
  deployed site are always behind authentication.

Each project also has a **capability set** (website always on; \`database\`
and \`mcp\` optional, plus a \`shared\` data flag). \`get_project\` returns the
enabled capabilities; \`set_capabilities\` changes them (the platform
enables/disables the per-project Postgres and regenerates the k8s manifests).

Use \`create_project\` to add one — pass \`capabilities: { database, mcp,
shared }\` to start with more than a website. The platform provisions the
Gitea repo from the Community Center template (Dockerfile, build + scan
workflows, all capability modules) and generates the k8s manifests for the
chosen capabilities.

**Deleting a project.** \`delete_project\` is a full cascade — Gitea
repo, ArgoCD Application, project namespace (which takes pods + PVCs +
Sealed Secrets with it), and finally the portal DB row. It is
destructive and irreversible; any data in the project's Postgres PVC
is lost. Pass \`keep_repo: true\` to archive the code first, or
\`keep_namespace: true\` to keep the live workload up for forensics —
both default to false. \`confirm_slug\` must match the project slug
exactly as a guard against typos.
`,
  gitea: `# Gitea credentials

The user authenticates to Gitea via OIDC in the browser (same identity as
the portal). For \`git clone\` / \`git push\` over HTTPS, they need a
Personal Access Token — Gitea doesn't accept the OIDC cookie at the git
endpoint.

Call \`get_gitea_credentials\` with the project id or slug. The portal
mints a fresh PAT on the user's Gitea account scoped to
\`write:repository\` and returns:
- \`username\` (the Gitea login)
- \`token\` (the PAT — treat as a secret)
- \`clone_url\` (the plain \`https://${GITEA_HOST}/<owner>/<slug>.git\`
  URL, with NO credentials in it)
- \`token_name\` (Gitea-side name; you can delete it via Gitea's UI
  later)
- \`usage\` (a ready-to-run git credential-helper invocation)

Supply the token via a git credential helper / \`GIT_ASKPASS\`, NOT by
embedding it in the remote URL. A \`https://<user>:<token>@…\` remote
leaks the secret into \`.git/config\`, shell history, and CI logs. Use the
returned \`usage\` string, e.g.:

\`\`\`sh
export CV_TOKEN=<token>
git -c credential.helper='!f(){ echo "username=<username>"; echo "password=$CV_TOKEN"; };f' clone <clone_url>
\`\`\`

The token is user-wide, not repo-scoped (Gitea limitation). Mint a fresh
one per project to keep the names tidy.
`,
  pipeline: `# Build + scan pipeline

On every push to \`main\` the project repo runs two Gitea Actions
workflows (already present in the template, do not edit):

- \`Build\` — \`docker build\` the repo's Dockerfile, push to
  \`${CV_REGISTRY}/<owner>/<slug>\` tagged
  with the build timestamp \`YYYYMMDDHHMMSS\` (immutable) and the short
  SHA. Then it calls the Corpo Valley portal (in-cluster URL
  \`${PORTAL_PIN_HOST}/internal/projects/<slug>/pin\`),
  which writes the pin commit to \`k8s/deployment.yaml\` as cvportal
  with \`[skip ci]\` — the workflow itself holds no git push
  credentials. Rollback is \`git revert\` of the bump commit; no force
  pushes required.
- \`Scan\` — semgrep \`--config=auto\` + osv-scanner. Findings exit
  non-zero. Branch protection blocks PR merges until both scans pass on
  the new commit; direct push to \`main\` is allowed but failures show
  as red checks in the Actions tab.

Semgrep is scoped with \`--exclude k8s --exclude .gitea\` so the
platform-managed scaffold doesn't noise up the user's first push.

Adding new workflows is discouraged for non-technical users — ask before
proposing one.

**Checking status:** after pushing, call \`get_project_status\` with the
project's slug. You get the combined \`state\` ("success" / "failure" /
"pending") and a per-check breakdown so you can see which job failed and
deep-link the user to its log via the \`target_url\` field.

**Reading the actual log output.** When a scan fails, call
\`get_ci_logs\` to read the real semgrep / osv-scanner output for the
ref. Use \`workflow_name_includes: "Scan"\` and
\`job_name_includes: "semgrep"\` to narrow to one job. Logs are tail-
capped per job (defaults to 400 lines from the end, where failures
always live).

**Promoting via PR.** For dev/prod separation, push a feature branch to
the repo, then \`create_pr(project, title, head, base?)\` to open a PR
against \`main\`. Use \`list_prs\` to see open PRs, \`get_project_status\`
on the PR head sha to wait for scans to go green, and \`merge_pr\`
(defaults to squash) once they do. Branch protection rejects merges
with failing status checks.
`,
  secrets: `# Sealed secrets

The user manages runtime secrets through the portal: Project → Configure
→ "Sealed secrets". Pasting \`KEY=VALUE\` per line and submitting causes
the portal to:

1. Encrypt each value with the in-cluster sealed-secrets controller's
   public cert (RSA-OAEP-SHA256 + AES-256-GCM, label bound to the
   destination namespace + secret name).
2. Build a \`SealedSecret\` YAML and commit it to the user's repo at
   \`k8s/secrets/<name>.sealed.yaml\` via the Gitea Contents API.
3. ArgoCD syncs it; the sealed-secrets controller decrypts it into a
   Kubernetes Secret in the project's namespace.

You can do the same programmatically with \`set_project_secret\`. The
materialised Secret can be referenced from your Deployment with
\`envFrom: - secretRef: { name: <secret_name> }\` or per-key with
\`valueFrom.secretKeyRef\`. The secret name is what you passed; values
land under their KEY names verbatim.

Don't ever commit plaintext secrets. Use the sealed flow.
`,
  kubernetes: `# Inspecting Kubernetes

You can read Kubernetes objects from a project's namespace to debug
deploys without leaving the conversation. Two tools:

- \`kube_get\` — list-or-detail for a kind in a namespace. Pass the kind
  name (Pod, Deployment, Service, Ingress, Event, ConfigMap,
  SealedSecret, ReplicaSet, Job, etc.). Without a \`name\` you get a
  trimmed list (status, restarts, image, etc.); with one you get the
  full resource (managedFields stripped). \`label_selector\` filters.
- \`kube_logs\` — recent stdout/stderr from a pod. Defaults to the last
  200 lines; set \`previous: true\` to read the crashed-container logs
  if a pod is in CrashLoopBackOff.

These are **read-only**. Secrets aren't readable through here (Sealed
Secrets are the secret flow). No exec, no port-forward, no apply or
patch — deploying still happens via \`git push\` → Gitea Actions →
ArgoCD. The tools refuse any \`namespace\` that doesn't match a project
slug the caller owns.

Common debugging recipe:

1. \`get_project_status\` — did CI go green?
2. \`kube_get\` Pod in the project namespace — Running, Pending,
   CrashLoopBackOff?
3. If CrashLoopBackOff or Pending, \`kube_get\` Event in the namespace —
   FailedMount, ImagePullBackOff, etc.
4. If the pod is up but the app is broken, \`kube_logs\` on the pod.
`,

  database: `# Database

Each project can optionally have its own Postgres database — a single
\`postgres:16-alpine\` pod with a 5 GiB PVC, deployed into the project's
namespace. Only one tier, no replicas, no HA; it's intentionally simple
and per-project so blast radius == the project namespace.

**Enable / disable:**
- MCP: \`enable_postgres(project_id_or_slug)\` (idempotent) or
  \`disable_postgres(project_id_or_slug, destroy_data?)\`.
- Portal UI: the Database card on the project detail page.

Enable commits two files to the project repo as cvportal:
- \`k8s/postgres.yaml\` — StatefulSet + headless Service
- \`k8s/secrets/postgres.sealed.yaml\` — SealedSecret with the
  credentials

ArgoCD picks them up within a minute and the kubelet starts the pod.

**Using it from your app.** The sealed Secret materialises as a regular
Secret named \`postgres\` in the project namespace with the keys
\`POSTGRES_USER\`, \`POSTGRES_PASSWORD\`, \`POSTGRES_DB\`, and
\`DATABASE_URL\`. The platform-generated \`database\` container already wires
\`DATABASE_URL\` from it via \`valueFrom.secretKeyRef\`. If you hand-write your
own Deployment, project it the same way:

\`\`\`yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: postgres
        key: DATABASE_URL
\`\`\`

Your code then reads \`DATABASE_URL=postgres://app:<pw>@postgres:5432/app\`
(the headless Service in the same namespace; no cross-namespace traffic).

**Disable behaviour.** Calling \`disable_postgres\` removes both files
from the repo; ArgoCD prunes the StatefulSet, Service, and Secret on
the next sync. The PVC is preserved by default — the volumeClaimTemplate
PVC isn't owned by the StatefulSet, so calling \`enable_postgres\`
again later re-binds the same data (and the same password, kept in the
projects row across cycles). Pass \`destroy_data: true\` to also delete
the PVC and clear the password; the next enable starts fresh.

**Bounds.** A platform VAP (\`cv-projects-postgres-bounds\`) constrains
the StatefulSet that lands in the cluster: image must be one of the
two approved postgres images, replicas==1, storage <= 10 GiB, no
privileged / hostPath / host* anything. Edits to \`k8s/postgres.yaml\`
that violate these get rejected at admission, so a hand-modified
manifest can't widen the blast radius.
`,
  deploy: `# Deploy

The project's repo has three platform-generated k8s manifests in \`k8s/\`:
\`deployment.yaml\` (one container per enabled capability), \`service.yaml\`
(one Service per capability), and \`ingress.yaml\` (path-routed: \`/\`,
\`/api\`, \`/mcp\`) — all wired to the project's namespace, the in-cluster
registry image path, and the \`<slug>.${PROJECTS_DOMAIN}\` Ingress host with the
Kratos \`/sessions/whoami\` auth-url annotation. These are regenerated by
\`set_capabilities\`; don't hand-edit them.

ArgoCD's projects instance (\`cv-projects-argocd\`) syncs the repo's
\`k8s/\` path with \`recurse: true\`, so the user-managed
\`k8s/secrets/<name>.sealed.yaml\` files also land. Sync happens within
a few minutes of any commit to \`main\`.

**Checking the deploy state.** Call \`get_argo_status\` with the
project slug. It returns the Application's sync state (Synced /
OutOfSync), the revision ArgoCD has, health status (Healthy /
Progressing / Degraded / Suspended / Missing), the last sync operation
result, and any non-Healthy child resources — one call, no chain of
\`kube_get\` reads. Pass \`also_sync: true\` to also kick a refresh+sync
from HEAD.

**Forcing a pod restart.** When you want to roll the pods without
changing the manifest (e.g. to pick up a new sealed Secret value), call
\`restart_project\` with the project slug. It deletes the pods so the
ReplicaSet recreates them — this works under ArgoCD selfHeal where
patching the Deployment template annotation does not. Optionally pass
\`deployment: "<name>"\` to roll just one workload.

Each capability container listens on its own port (website 8080, database
3000, mcp 9000) and the generated Services target them by name. You don't
manage ports — \`set_capabilities\` regenerates the manifests. Push code
changes to a capability module and the single image rebuilds; all containers
move to the new tag together.
`,
  access: `# Access

The portal is gated by Ory Kratos sessions. Cookies are scoped to
\`${BASE_DOMAIN}\` so the same session covers \`portal\`, \`auth\`,
\`oauth\`, \`gitea\`, and every \`<slug>.${PROJECTS_DOMAIN}\`.

Project Ingresses carry an \`auth-url\` annotation pointing at Kratos's
\`/sessions/whoami\`. nginx-ingress forwards the request cookies; a valid
session → 200, no session → 401 → redirect to portal login. The forwarded
Kratos cookie also reaches the backend containers, where the database/mcp
capabilities re-validate it against Kratos to identify the caller (per-user
data scoping). A workload can't forge an identity — it needs a real session.

There is no \`open\` (unauthenticated) visibility tier — the ingress-bounds
VAP rejects any project Ingress that lacks the platform auth-url
annotation, so a deployed site can never be reached without a Kratos
session.

Roles are simple: every account is a regular **user**; **admins**
additionally manage users, services, and the project template via the
portal's Admin pages. The admin role is an Ory Keto grant, issued from
Admin → Users (or bootstrap-admin.sh for the first admin). There are no
other tiers.
`,
};

export function getDocsTopic(topic?: string): { topic: DocsTopic; markdown: string } {
  const key = (topic && (topic in TOPICS) ? topic : 'overview') as DocsTopic;
  return { topic: key, markdown: TOPICS[key].trim() + '\n' };
}

export function listDocsTopics(): DocsTopic[] {
  return Object.keys(TOPICS) as DocsTopic[];
}
