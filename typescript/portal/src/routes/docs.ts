// Public documentation pages (no session required, no CSRF). For now just
// /docs/mcp — the editor setup walkthrough that RFC 9728's
// `resource_documentation` field points clients at.
import { Router, Request, Response } from 'express';
import { renderMcpDocs } from '../templates';
import { MCP_ENDPOINT_URL, PORTAL_PUBLIC_URL, OAUTH_PUBLIC_URL } from '../services/platform-config';

const router = Router();

// OAuth host for the plain-text mirror, derived from this deployment's own URL
// (single source: services/platform-config) — never hardcoded corpo-valley.com.
const OAUTH_HOST = (() => { try { return new URL(OAUTH_PUBLIC_URL).host; } catch { return 'oauth'; } })();

router.get('/docs/mcp', (_req: Request, res: Response) => {
  res.send(renderMcpDocs());
});

// Plain-text well-known mirror so MCP clients that prefer to load docs
// from a stable, no-frame URL can grab the same content.
router.get('/docs/mcp.txt', (_req: Request, res: Response) => {
  res.type('text/plain').send(`Corpo Valley MCP — editor setup

See ${PORTAL_PUBLIC_URL}/docs/mcp for the full walkthrough.

Quick start:
  claude mcp add --transport http corpo-valley ${MCP_ENDPOINT_URL}

OAuth is automatic on first use: your editor opens a browser to
${OAUTH_HOST}, you sign in, and tokens land back in the editor.
Nothing to paste.
`);
});

export default router;
