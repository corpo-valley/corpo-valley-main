// Public documentation pages (no session required, no CSRF). For now just
// /docs/mcp — the editor setup walkthrough that RFC 9728's
// `resource_documentation` field points clients at.
import { Router, Request, Response } from 'express';
import { renderMcpDocs } from '../templates';

const router = Router();

router.get('/docs/mcp', (_req: Request, res: Response) => {
  res.send(renderMcpDocs());
});

// Plain-text well-known mirror so MCP clients that prefer to load docs
// from a stable, no-frame URL can grab the same content.
router.get('/docs/mcp.txt', (_req: Request, res: Response) => {
  res.type('text/plain').send(`Corpo Valley MCP — editor setup

See https://portal.corpo-valley.com/docs/mcp for the full walkthrough.

Quick start:
  claude mcp add --transport http corpo-valley https://mcp.corpo-valley.com/mcp

OAuth is automatic on first use: your editor opens a browser to
oauth.corpo-valley.com, you sign in, and tokens land back in the editor.
Nothing to paste.
`);
});

export default router;
