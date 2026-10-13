# Project admin tier on the portal (supersedes the owner-only rule)

**Date:** 2026-10-13 · **Status:** accepted

## Context

The 2026-06-12 access decision left portal-level project management
(settings, secrets, capabilities, sharing, delete) **strictly owner-only**,
even for users holding an `admin` grant. Site `admin` was defined as an
in-app permission class only. In practice that meant a user the owner had
explicitly made an admin could not administer the project anywhere but
through the MCP tools, which already honoured grants
(`resolveAccessibleProject` + per-tool minimum repo perm). Owners reported it
as a bug: "I made them admin and they still get a 404."

## Decision

The portal now derives a **dashboard tier** per viewer
(`services/project-tier.ts`) and gates every project route on it instead of
`owner_id === session.id`:

| tier  | who                                                                        | may |
|-------|----------------------------------------------------------------------------|-----|
| admin | owner; platform admins; explicit grantee with `admin` on site **or** repo  | everything: delete, destroy data volumes, manage sharing |
| write | explicit grantee with repo `write`                                         | sealed secrets, enable/disable Postgres and storage (data kept) |
| read  | explicit grantee with repo `read`                                          | open the project page, status, mint a clone token |
| none  | everyone else, including members who only hold the `everyone` grant        | 404 (indistinguishable from "no such project") |

Only **explicit** grants (direct user or group) count. The org-wide
`everyone` grant is a statement about the deployed app ("any member may use
the site" / "may clone the repo") and never opens the management page: an
owner who sets General access = write must not thereby let every signed-in
user commit secrets to the repo. Read and write come from the **repo**
facet, exactly like the MCP tools (`resolveAccessibleProject` uses
`effectiveRepoPerm`); site `write` stays an in-app permission class. `admin`
on either facet makes a project admin, because that is what an owner means
when they pick admin in the Share panel. (`everyone` can never carry admin
anyway: DB CHECK.)

Platform admins get `admin` on every project. They can already delete users
and reset the template; letting them open and manage any project is the
"view all projects" half of the platform-admin feature, and it is labelled
on the page.

## Consequences

- `GET /projects/:id` renders for any viewer with access; the cards shown
  match the tier (read: view-only, write: no Danger zone / sharing /
  destroy-data checkbox). The server enforces the same tier on every POST,
  with a 403 that names the missing level once the viewer can see the
  project.
- The "Shared with you" cards on `/` link to the project page.
- The post-login redirect to a project host stays owner-only (it is an
  open-redirect guard, not an access decision).
- Minting a CLI token for a shared project checks the viewer's **repo**
  perm (the form is hidden otherwise); the "repo owned by a different Gitea
  account" refusal now applies to owners only, because collaborators mint
  tokens on their own account.
- The 2026-06-12 bullet "portal project management stays strictly
  owner-only" is superseded by this document.
