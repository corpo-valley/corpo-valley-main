# Access control for your project — the X-CV-Perm standard

Corpo Valley authenticates and authorizes every visitor **before** their request reaches your
containers. You don't implement login, sessions, or an access check — you read three headers.

## The three classes

The project owner controls who gets which class (portal → your project → Access): a default for
all signed-in members (`none`/`read`/`write`), plus per-user and per-group grants
(`read`/`write`/`admin`). The highest applicable level wins; the owner is always `admin`.

| `X-CV-Perm` | Meaning (the convention your code should follow) |
|-------------|--------------------------------------------------|
| `read`      | May view. Serve pages and GET endpoints. The platform guarantees nobody below `read` ever reaches you. |
| `write`     | May participate: create, update, and delete **their own** data. |
| `admin`     | App-level moderator: may manage **anyone's** data in your app. |

`admin` here is an *application* permission class — it does not grant portal powers (project
settings, secrets, deletion stay owner-only).

## The headers

Every request your containers receive carries:

```
X-CV-User-Id:     2f0c…           # stable identity id — use as your owner_id
X-CV-User-Email:  alice@example.com
X-CV-Perm:        read | write | admin
```

These are **trustworthy**: the Ingress annotation `auth-response-headers` makes nginx overwrite
them from the platform's auth answer on every request, so a client-supplied copy never survives
the edge, and the platform's network policy stops other projects from calling your Services
directly. Anonymous visitors are redirected to login; signed-in members without `read` get a 403
before your code runs.

## Using them

The template ships a helper (`lib/identity.js`):

```js
const { resolveUser, requirePerm } = require('../lib/identity');

app.use('/api', requirePerm('read'));               // floor for the router
app.post('/api/things', requirePerm('write'), h);   // participation
app.delete('/api/things/:id', requirePerm('write'), async (req, res) => {
  // req.userId, req.userEmail, req.userPerm are set by requirePerm
  const mine = 'DELETE FROM things WHERE id=$1 AND owner_id=$2';
  const any  = 'DELETE FROM things WHERE id=$1';   // admins moderate everything
  await pool.query(req.userPerm === 'admin' ? any : mine,
    req.userPerm === 'admin' ? [req.params.id] : [req.params.id, req.userId]);
  res.json({ ok: true });
});
```

Rules of thumb:

- **Gate every mutating route with `requirePerm('write')`.** GETs are already covered by the
  platform's `read` floor.
- **Always take `owner_id` from `req.userId`**, never from the request body.
- **Reserve `admin` for moderation paths** (delete anyone's row, edit shared config). Don't make
  normal features require it.
- The `database` capability's `CV_SHARED` env is orthogonal: it controls whether *reads* span all
  users' rows or only the caller's. Permission classes control *who may act*; `CV_SHARED`
  controls *what data a read returns*.

## Local development

Running a container outside the cluster, the headers are absent. Easiest local approximation: set
the headers yourself with curl, e.g. `curl -H 'X-CV-User-Id: dev' -H 'X-CV-Perm: admin' …`.

There is also a cookie fallback: with `CV_DEV_COOKIE_FALLBACK=1` set, `resolveUser` validates an
`ory_kratos_session` cookie against Kratos and reports `write`. **It is off by default and must never
be enabled in a deployed container** — in the cluster the trusted edge headers are always present, so
a deployment with the fallback off fails closed (denies) if its auth-url is ever misconfigured,
instead of silently granting `write` to any signed-in member. A request carrying `X-CV-User-Id` but
no valid `X-CV-Perm` (i.e. not through the platform edge) is likewise denied.

## MCP capability note

The `/mcp` endpoint is OAuth-authenticated by the platform's MCP gateway rather than the cookie
edge, but access **mirrors the site gate**: the gateway admits any user with at least `read`
(owner, direct grant, group grant, or site default >= read — the owner is always `admin`). It
forwards `X-User-Id`, `X-User-Email`, and `X-CV-Perm`.

Per-tool authorization is **your** responsibility, exactly like the site's mutating routes: gate
which tools a caller may invoke on `X-CV-Perm`. A typical split is read-only tools for `read`,
create/update-your-own for `write`, and moderation tools for `admin`:

```js
const { resolveUser } = require('../lib/identity'); // reads X-User-Id / X-CV-Perm
// inside your MCP tool dispatch:
if (TOOL_WRITES.has(toolName) && req.userPerm === 'read') {
  return { error: 'requires write access' };
}
```
