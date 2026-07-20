// HTML template rendering helpers for Ory auth flows + Corpo Valley dashboard.
//
// Branding note: Corpo Valley wears a light Stardew-Valley-ish coat — a warm
// earthy palette and a 🌱 sprout in the wordmark — without going full
// pixel-art. The structural CSS approach (clean, responsive, inline) is
// carried over from the reference portal.

import { cspNonce } from './lib/csp-nonce';
import {
  GITEA_PUBLIC_URL, PROJECTS_DOMAIN, BASE_DOMAIN,
  PORTAL_PUBLIC_URL, MCP_ENDPOINT_URL, OAUTH_PUBLIC_URL,
  COOLDEPS_ENABLED,
} from './services/platform-config';

const GOOGLE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align:middle;margin-right:8px;"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

const GITHUB_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:6px;"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

const SITE_FOOTER = `
    <footer class="site-footer">
      <a href="https://github.com/corpo-valley/corpo-valley-main" target="_blank" rel="noopener noreferrer">${GITHUB_SVG}corpo-valley on GitHub</a>
    </footer>`;

// Deployment-specific public URLs come from ./services/platform-config (the
// single source of truth, imported above) — its fallbacks derive from the
// deployment's own domain, so a deployment on another domain never renders
// corpo-valley.com links. Build a project's public site URL from its slug.
function projectSiteUrl(slug: string): string { return `https://${slug}.${PROJECTS_DOMAIN}`; }

// Warm valley palette: deep soil-night background, parchment text, harvest
// gold + leaf green accents.
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #2b2118;
    color: #f3ead9;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    background: #3a2e22;
    border-radius: 16px;
    padding: 2.5rem 2rem 2rem;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  .brand {
    text-align: center;
    margin-bottom: 0.25rem;
  }
  .brand-name {
    font-size: 1.6rem;
    font-weight: 700;
    background: linear-gradient(135deg, #e8b94a, #84a25a);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.02em;
  }
  .brand-sub {
    font-size: 0.8rem;
    color: #a89878;
    margin-top: 0.15rem;
  }
  h1 {
    font-size: 1.25rem;
    margin-bottom: 1.25rem;
    text-align: center;
    color: #fdf6e8;
    font-weight: 600;
  }
  .messages { margin-bottom: 1rem; }
  .message {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 0.5rem;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .message.error { background: #45211a; color: #f3a5a5; border: 1px solid #7f3d1d; }
  .message.success { background: #2d3a1c; color: #c3e0a0; border: 1px solid #4d6624; }
  .message.info { background: #3a3120; color: #e8d39a; border: 1px solid #6b5a2a; }
  .field { margin-bottom: 1rem; }
  label {
    display: block;
    font-size: 0.8rem;
    color: #c4b698;
    margin-bottom: 0.35rem;
    font-weight: 500;
  }
  input[type="text"], input[type="email"], input[type="password"], input[type="tel"] {
    width: 100%;
    padding: 0.7rem 0.85rem;
    background: #2b2118;
    border: 1px solid #5a4a36;
    border-radius: 8px;
    color: #fdf6e8;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  input:focus { border-color: #e8b94a; box-shadow: 0 0 0 3px rgba(232,185,74,0.15); }
  input[type="hidden"] { display: none; }
  /* Auth-page submit buttons (login/flow/recovery/settings) are full-width
     green. Scoped with :not(.btn) so dashboard .btn submit buttons keep their
     own variant styling (.btn-primary/.btn-secondary/.btn-danger) instead of
     being overridden by this higher-specificity element rule. */
  button[type="submit"]:not(.btn), input[type="submit"]:not(.btn) {
    width: 100%;
    padding: 0.75rem;
    background: #84a25a;
    color: #1f2912;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    margin-top: 0.25rem;
  }
  button[type="submit"]:not(.btn):hover, input[type="submit"]:not(.btn):hover { background: #93b366; }
  button[type="submit"]:not(.btn):active { transform: scale(0.98); }
  .links {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.85rem;
  }
  .links a {
    color: #e8b94a;
    text-decoration: none;
    font-weight: 500;
  }
  .links a:hover { text-decoration: underline; }
  .divider {
    display: flex;
    align-items: center;
    margin: 1.25rem 0;
    color: #8a7a5a;
    font-size: 0.8rem;
  }
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #5a4a36;
  }
  .divider::before { margin-right: 0.75rem; }
  .divider::after { margin-left: 0.75rem; }
  .separator {
    margin: 0.75rem 0;
    border: none;
    border-top: 1px solid #5a4a36;
  }
  .social-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 0.7rem;
    margin-bottom: 0.5rem;
    background: #fff;
    color: #1f2937;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .social-btn:hover { background: #f3f4f6; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .error-page { text-align: center; }
  .error-page p { margin: 0.5rem 0; color: #c4b698; }
  .error-page code { background: #2b2118; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }

  /* Dashboard layout */
  body.dashboard-body { align-items: stretch; justify-content: stretch; }
  .dashboard-wrap { display: flex; width: 100%; min-height: 100vh; }
  .nav { width: 220px; background: #3a2e22; padding: 1.5rem 1rem; border-right: 1px solid #5a4a36; flex-shrink: 0; }
  .nav h2 { font-size: 1.1rem; color: #fdf6e8; margin-bottom: 1.5rem; }
  .nav a { display: block; padding: 0.5rem 0.75rem; color: #c4b698; text-decoration: none; border-radius: 6px; margin-bottom: 0.25rem; font-size: 0.9rem; }
  .nav a:hover { background: #4a3c2c; color: #fdf6e8; }
  .nav a.active { background: #84a25a; color: #1f2912; }
  .nav .nav-section { font-size: 0.75rem; color: #8a7a5a; text-transform: uppercase; letter-spacing: 0.05em; margin: 1rem 0 0.5rem 0.75rem; }
  .nav .nav-user { font-size: 0.8rem; color: #8a7a5a; padding: 0 0.75rem; margin-bottom: 1rem; }
  .main { flex: 1; padding: 2rem; max-width: 900px; }
  .main h1 { text-align: left; margin-bottom: 1rem; }
  .tagline { color: #a89878; font-size: 0.85rem; margin-bottom: 1.25rem; }

  /* App / project grid */
  .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
  .app-card { background: #3a2e22; border: 1px solid #5a4a36; border-radius: 8px; padding: 1.25rem; }
  .app-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .app-card-name { font-weight: 600; color: #fdf6e8; font-size: 1rem; }
  .app-card-sub { font-size: 0.8rem; color: #a89878; margin-bottom: 0.5rem; }
  .app-card-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .btn { display: inline-block; width: auto; padding: 0.4rem 0.75rem; border-radius: 5px; font-size: 0.85rem; text-decoration: none; border: none; cursor: pointer; font-weight: 500; text-align: center; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #84a25a; color: #1f2912; }
  .btn-primary:hover { background: #93b366; }
  .btn-secondary { background: #4a3c2c; color: #f3ead9; }
  .btn-secondary:hover { background: #5a4a36; }
  .btn-danger { background: #7f3d1d; color: #f3a5a5; }
  .btn-danger:hover { background: #6b3217; }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

  /* Role badges */
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .badge-ADMIN { background: #7f3d1d; color: #f3a5a5; }
  .badge-USER { background: #4d6624; color: #c3e0a0; }
  .badge-access { background: #4a3c2c; color: #c4b698; }

  /* Tables */
  .table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  .table th { text-align: left; padding: 0.6rem 0.75rem; color: #c4b698; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid #5a4a36; }
  .table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #4a3c2c; font-size: 0.9rem; }
  .table tr:hover td { background: #3a2e22; }
  .table a { color: #e8b94a; text-decoration: none; }
  .table a:hover { text-decoration: underline; }
  .table code { background: #2b2118; padding: 0.1rem 0.35rem; border-radius: 4px; }

  /* Forms in dashboard */
  .inline-form { display: inline; }
  select { padding: 0.4rem 0.5rem; background: #2b2118; border: 1px solid #5a4a36; border-radius: 5px; color: #fdf6e8; font-size: 0.85rem; }
  .form-row { display: flex; gap: 0.75rem; align-items: end; margin-bottom: 1rem; }
  .form-row .field { flex: 1; margin-bottom: 0; }
  .help { color: #a89878; font-size: 0.85rem; margin-bottom: 0.75rem; }

  /* Key display */
  .key-display { background: #2b2118; border: 1px solid #5a4a36; border-radius: 6px; padding: 1rem; margin: 1rem 0; word-break: break-all; font-family: monospace; font-size: 0.85rem; }
  .key-warning { color: #e8b94a; font-size: 0.85rem; margin-top: 0.5rem; }
  .snippet { background: #2b2118; border: 1px solid #5a4a36; border-radius: 6px; padding: 0.85rem; font-size: 0.8rem; line-height: 1.5; overflow-x: auto; color: #f3ead9; white-space: pre-wrap; word-break: break-all; }

  /* Pagination */
  .pagination { display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
  .pagination a, .pagination span { padding: 0.4rem 0.75rem; border-radius: 5px; font-size: 0.85rem; text-decoration: none; }
  .pagination a { background: #4a3c2c; color: #f3ead9; }
  .pagination a:hover { background: #5a4a36; }
  .pagination span.current { background: #84a25a; color: #1f2912; }

  /* Mobile nav toggle */
  .nav-toggle { display: none; position: fixed; top: 0.75rem; left: 0.75rem; z-index: 1001; background: #3a2e22; border: 1px solid #5a4a36; border-radius: 6px; color: #f3ead9; padding: 0.5rem 0.65rem; cursor: pointer; font-size: 1.2rem; line-height: 1; }
  .nav-overlay { display: none; }

  /* Table responsive wrapper */
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }

  /* Mobile styles */
  @media (max-width: 768px) {
    .container { margin: 1rem; padding: 1.5rem 1.25rem; max-width: none; }
    body { align-items: flex-start; padding-top: 2rem; }

    .nav-toggle { display: block; }
    .nav-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999; }
    .nav-overlay.open { display: block; }

    .dashboard-wrap { flex-direction: column; }
    .nav {
      position: fixed; top: 0; left: 0; bottom: 0; width: 260px; z-index: 1000;
      transform: translateX(-100%); transition: transform 0.25s ease;
      overflow-y: auto; padding-top: 3.5rem;
    }
    .nav.open { transform: translateX(0); }
    .main { padding: 1rem; padding-top: 3.5rem; max-width: none; }
    .main h1 { font-size: 1.1rem; }

    .app-grid { grid-template-columns: 1fr; }
    .app-card-actions { flex-wrap: wrap; }
    .app-card-actions .btn { flex: 1; min-width: 0; }

    .table { font-size: 0.8rem; }
    .table th, .table td { padding: 0.5rem; }
    .table code { font-size: 0.7rem; word-break: break-all; }

    .form-row { flex-direction: column; gap: 0.5rem; }
    .form-row .btn { width: 100%; }

    .inline-form { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
    .inline-form select { font-size: 0.8rem; }

    .key-display { font-size: 0.75rem; padding: 0.75rem; }
    .btn { padding: 0.5rem 0.85rem; }
    input[type="text"], input[type="email"], input[type="password"], input[type="tel"] {
      font-size: 1rem;
    }
    select { font-size: 0.9rem; padding: 0.5rem; }
  }

  .site-footer { text-align: center; margin-top: 1.75rem; font-size: 0.8rem; }
  .site-footer a { color: #8a7a5a; text-decoration: none; }
  .site-footer a:hover { color: #e8b94a; }
  .main .site-footer { margin-top: 3rem; padding-bottom: 1rem; }

  @media (max-width: 380px) {
    .container { margin: 0.5rem; padding: 1.25rem 1rem; }
    .brand-name { font-size: 1.3rem; }
    h1 { font-size: 1.1rem; }
  }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Corpo Valley</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-name">🌱 Corpo Valley</div>
      <div class="brand-sub">Tend your code, harvest your apps</div>
    </div>
    ${body}
${SITE_FOOTER}
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export interface UiNode {
  type: string;
  group: string;
  attributes: {
    name?: string;
    type?: string;
    value?: string;
    disabled?: boolean;
    node_type: string;
    label?: { text: string };
    onclick?: string;
    required?: boolean;
  };
  messages: Array<{ type: string; text: string }>;
  meta: { label?: { text: string } };
}

export interface UiMessage {
  type: string;
  text: string;
}

function renderMessages(messages?: UiMessage[]): string {
  if (!messages || messages.length === 0) return '';
  return `<div class="messages">
    ${messages.map(m => `<div class="message ${escapeHtml(m.type)}">${escapeHtml(m.text)}</div>`).join('\n')}
  </div>`;
}

function renderNode(node: UiNode): string {
  const attrs = node.attributes;
  const nodeType = attrs.node_type || attrs.type;

  if (nodeType === 'script') return '';
  if (nodeType === 'img') return '';

  // Messages on individual nodes
  const nodeMessages = node.messages
    .map(m => `<div class="message ${escapeHtml(m.type)}">${escapeHtml(m.text)}</div>`)
    .join('');

  if (attrs.type === 'hidden') {
    return `<input type="hidden" name="${escapeHtml(attrs.name || '')}" value="${escapeHtml(attrs.value || '')}">`;
  }

  if (attrs.type === 'submit') {
    const label = (node.meta.label?.text || attrs.value || 'Submit');
    if (node.group === 'oidc') {
      const provider = attrs.value || '';
      const icon = provider === 'google' ? GOOGLE_SVG : '';
      const displayLabel = provider === 'google'
        ? 'Continue with Google'
        : label;
      return `${nodeMessages}<button type="submit" name="${escapeHtml(attrs.name || '')}" value="${escapeHtml(attrs.value || '')}" class="social-btn">${icon}${escapeHtml(displayLabel)}</button>`;
    }
    // Clean up button labels
    const cleanLabel = label
      .replace('Sign in with password', 'Sign in')
      .replace('Send sign in code', 'Email me a code')
      .replace('Sign up', 'Continue');
    return `${nodeMessages}<button type="submit" name="${escapeHtml(attrs.name || '')}" value="${escapeHtml(attrs.value || '')}">${escapeHtml(cleanLabel)}</button>`;
  }

  if (attrs.type === 'button') {
    const label = (node.meta.label?.text || attrs.value || 'Submit');
    return `${nodeMessages}<button type="submit" name="${escapeHtml(attrs.name || '')}" value="${escapeHtml(attrs.value || '')}">${escapeHtml(label)}</button>`;
  }

  // Anchor nodes (e.g., "Sign up instead" links)
  if (nodeType === 'a') {
    const label = node.meta.label?.text || attrs.name || 'Link';
    const href = (attrs as any).href || '#';
    return `<div class="links"><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></div>`;
  }

  // Text nodes
  if (nodeType === 'text') {
    const label = node.meta.label?.text || '';
    const text = (attrs as any).text?.text || attrs.value || '';
    return `<div class="field">
      ${label ? `<label>${escapeHtml(label)}</label>` : ''}
      <code>${escapeHtml(text)}</code>
      ${nodeMessages}
    </div>`;
  }

  // Default: input field
  const label = node.meta.label?.text || attrs.name || '';
  const inputType = attrs.type || 'text';
  const required = attrs.required ? ' required' : '';
  const disabled = attrs.disabled ? ' disabled' : '';
  const value = attrs.value ? ` value="${escapeHtml(attrs.value)}"` : '';

  return `<div class="field">
    ${label ? `<label for="${escapeHtml(attrs.name || '')}">${escapeHtml(label)}</label>` : ''}
    <input type="${escapeHtml(inputType)}" name="${escapeHtml(attrs.name || '')}" id="${escapeHtml(attrs.name || '')}"${value}${required}${disabled}>
    ${nodeMessages}
  </div>`;
}

export function renderFlow(
  title: string,
  action: string,
  method: string,
  nodes: UiNode[],
  messages?: UiMessage[],
  footerHtml?: string
): string {
  // Separate nodes by group
  const defaultNodes = nodes.filter(n => n.group === 'default');
  const passwordNodes = nodes.filter(n => n.group === 'password');
  const oidcNodes = nodes.filter(n => n.group === 'oidc');
  const codeNodes = nodes.filter(n => n.group === 'code');
  const totpNodes = nodes.filter(n => n.group === 'totp');
  const lookupNodes = nodes.filter(n => n.group === 'lookup_secret');
  const webauthnNodes = nodes.filter(n => n.group === 'webauthn');
  const profileNodes = nodes.filter(n => n.group === 'profile');
  const linkNodes = nodes.filter(n => n.group === 'link');

  let body = `<h1>${escapeHtml(title)}</h1>`;
  body += renderMessages(messages);

  // Helper: render a form with default nodes + group-specific nodes
  // Default nodes (csrf_token, trait fields) must be included in every form
  const hiddenDefaults = defaultNodes.filter(n => n.attributes.type === 'hidden');
  const visibleDefaults = defaultNodes.filter(n => n.attributes.type !== 'hidden');

  function formHtml(groupNodes: UiNode[], includeVisibleDefaults: boolean): string {
    return `<form action="${escapeHtml(action)}" method="${escapeHtml(method)}">
      ${hiddenDefaults.map(renderNode).join('\n')}
      ${includeVisibleDefaults ? visibleDefaults.map(renderNode).join('\n') : ''}
      ${groupNodes.map(renderNode).join('\n')}
    </form>`;
  }

  // OIDC (social login) buttons at top — no visible defaults needed (Google handles identity)
  if (oidcNodes.length > 0) {
    body += formHtml(oidcNodes, false);
    const hasManualForms = passwordNodes.length > 0 || codeNodes.length > 0 || profileNodes.length > 0;
    if (hasManualForms) {
      body += '<div class="divider">or</div>';
    }
  }

  // Password-based form — include visible defaults (email, name fields)
  if (passwordNodes.length > 0) {
    body += formHtml(passwordNodes, true);
  }

  // Profile form (two-step registration) — include visible defaults (email, name fields)
  if (profileNodes.length > 0) {
    body += formHtml(profileNodes, true);
  }

  // Code-based form (passwordless) — only if no password form (to avoid duplicate identifier fields)
  if (codeNodes.length > 0 && passwordNodes.length === 0) {
    body += formHtml(codeNodes, true);
  } else if (codeNodes.length > 0) {
    // Password form already shown — render code as a secondary option below
    body += '<div class="divider">or</div>';
    body += formHtml(codeNodes, false);
  }

  // TOTP form
  if (totpNodes.length > 0) {
    body += formHtml(totpNodes, false);
  }

  // Lookup secret form
  if (lookupNodes.length > 0) {
    body += formHtml(lookupNodes, false);
  }

  // WebAuthn form
  if (webauthnNodes.length > 0) {
    body += formHtml(webauthnNodes, false);
  }

  // Link form (recovery/verification via link)
  if (linkNodes.length > 0) {
    body += formHtml(linkNodes, true);
  }

  // Fallback: if no specific groups matched, render everything in one form
  if (
    passwordNodes.length === 0 &&
    oidcNodes.length === 0 &&
    codeNodes.length === 0 &&
    totpNodes.length === 0 &&
    lookupNodes.length === 0 &&
    webauthnNodes.length === 0 &&
    profileNodes.length === 0 &&
    linkNodes.length === 0
  ) {
    body += `<form action="${escapeHtml(action)}" method="${escapeHtml(method)}">
      ${defaultNodes.map(renderNode).join('\n')}
    </form>`;
  }

  if (footerHtml) {
    body += footerHtml;
  }

  return layout(title, body);
}

export function renderError(title: string, error: string, details?: string): string {
  let body = `<div class="error-page">
    <h1>${escapeHtml(title)}</h1>
    <div class="message error">${escapeHtml(error)}</div>`;
  if (details) {
    body += `<p><code>${escapeHtml(details)}</code></p>`;
  }
  body += `<div class="links" style="margin-top:2rem">
    <a href="/">Back to Portal</a>
  </div></div>`;
  return layout(title, body);
}

// Same-origin interstitial that finishes a form POST with a CLIENT-side
// navigation instead of a 302. Chromium enforces CSP `form-action` on the
// redirect chain of a form submission, so a /consent/accept or /logout/accept
// 302 to the Hydra origin (and onward to an arbitrary OAuth client redirect_uri
// — localhost, claude.ai, vscode://…) is silently cancelled and the page
// appears to "do nothing". Meta-refresh and script navigations are not subject
// to form-action, and the client redirect targets can't be allowlisted (DCR
// clients register arbitrary redirect_uris), so this is the durable fix.
export function renderFormRedirect(url: string): string {
  const jsUrl = JSON.stringify(url).replace(/</g, '\\u003c');
  const body = `
    <meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">
    <h1>Redirecting&hellip;</h1>
    <p style="color:#c4b698;margin-bottom:1rem;">Returning you to the application.</p>
    <script nonce="${cspNonce()}">window.location.replace(${jsUrl});</script>
    <div class="links"><a href="${escapeHtml(url)}">Continue</a></div>
  `;
  return layout('Redirecting', body);
}

export function renderConsentPage(
  clientName: string,
  scopes: string[],
  consentChallenge: string,
  csrfField: string = ''
): string {
  const scopeList = scopes.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  const body = `
    <h1>Authorize Application</h1>
    <p style="color:#c4b698;margin-bottom:1rem;"><strong>${escapeHtml(clientName)}</strong> is requesting access to your account.</p>
    ${scopes.length > 0 ? `<p style="color:#c4b698;margin-bottom:0.5rem;">Requested permissions:</p><ul style="color:#f3ead9;margin:0 0 1.5rem 1.5rem;">${scopeList}</ul>` : ''}
    <form method="POST" action="/consent/accept" style="margin-bottom:0.5rem;">
      ${csrfField}
      <input type="hidden" name="consent_challenge" value="${escapeHtml(consentChallenge)}">
      <button type="submit">Allow</button>
    </form>
    <form method="POST" action="/consent/deny">
      ${csrfField}
      <input type="hidden" name="consent_challenge" value="${escapeHtml(consentChallenge)}">
      <button type="submit" style="background:#4a3c2c;color:#f3ead9;">Deny</button>
    </form>
  `;
  return layout('Authorize', body);
}

// Device Authorization Grant (RFC 8628) user-code entry. Hydra redirects the
// browser here (from /oauth2/device/verify) with a device_challenge and,
// optionally, a pre-filled user_code (when the device advertised the "complete"
// verification URI). The human confirms the code to pair a headless/CLI client.
export function renderDeviceCodePage(
  deviceChallenge: string,
  userCode: string = '',
  csrfField: string = '',
  messages: UiMessage[] = [],
): string {
  const body = `
    <h1>Connect your device</h1>
    <p style="color:#c4b698;margin-bottom:1rem;">Enter the code shown on the device or app you're connecting.</p>
    ${renderMessages(messages)}
    <form method="POST" action="/device/accept">
      ${csrfField}
      <input type="hidden" name="device_challenge" value="${escapeHtml(deviceChallenge)}">
      <label for="user_code" style="display:block;color:#c4b698;margin-bottom:0.5rem;">Device code</label>
      <input id="user_code" name="user_code" value="${escapeHtml(userCode)}" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" style="text-transform:uppercase;letter-spacing:0.15em;">
      <button type="submit" style="margin-top:1rem;">Continue</button>
    </form>
  `;
  return layout('Connect your device', body);
}

export function renderLogoutConfirm(
  logoutChallenge: string,
  csrfField: string = ''
): string {
  const body = `
    <h1>Log out?</h1>
    <p style="color:#c4b698;margin-bottom:1.5rem;">You're about to be signed out of Corpo Valley.</p>
    <form method="POST" action="/logout/accept" style="margin-bottom:0.5rem;">
      ${csrfField}
      <input type="hidden" name="logout_challenge" value="${escapeHtml(logoutChallenge)}">
      <button type="submit">Log out</button>
    </form>
    <div class="links"><a href="/">Cancel</a></div>
  `;
  return layout('Log out', body);
}

export function renderInfo(title: string, message: string): string {
  const body = `<div class="error-page">
    <h1>${escapeHtml(title)}</h1>
    <div class="message info">${escapeHtml(message)}</div>
    <div class="links" style="margin-top:2rem">
      <a href="/">Back to Portal</a>
    </div>
  </div>`;
  return layout(title, body);
}

// ── Dashboard Templates ────────────────────────────────────

export function roleBadge(isAdmin: boolean): string {
  return isAdmin
    ? '<span class="badge badge-ADMIN">Admin</span>'
    : '<span class="badge badge-USER">User</span>';
}

interface NavItem { label: string; href: string; key: string; }

function dashboardLayout(
  title: string,
  bodyHtml: string,
  email: string,
  isAdmin: boolean,
  activeNav: string,
  // Optional extra markup injected into <head> (e.g. a no-JS meta refresh on
  // the initializing screen). Trusted, static, caller-supplied markup only —
  // never interpolate user input here.
  opts: { headExtra?: string } = {}
): string {
  const navItems: NavItem[] = [
    { label: 'Projects', href: '/', key: 'projects' },
    { label: 'Community', href: '/community', key: 'community' },
    { label: 'Groups', href: '/groups', key: 'groups' },
    { label: 'Connect Claude Code', href: '/connect', key: 'connect' },
  ];
  let adminNav = '';
  if (isAdmin) {
    adminNav = `
      <div class="nav-section">Admin</div>
      <a href="/admin/users"${activeNav === 'users' ? ' class="active"' : ''}>Users</a>
      <a href="/admin/apps"${activeNav === 'apps' ? ' class="active"' : ''}>Services</a>
      <a href="/admin/template"${activeNav === 'template' ? ' class="active"' : ''}>Project Template</a>
      <a href="/admin/projects/resources"${activeNav === 'resources' ? ' class="active"' : ''}>Project Resources</a>
      ${COOLDEPS_ENABLED ? `<a href="/admin/cooldeps"${activeNav === 'cooldeps' ? ' class="active"' : ''}>cooldeps</a>` : ''}
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Corpo Valley</title>
  ${opts.headExtra ?? ''}
  <style>${CSS}</style>
</head>
<body class="dashboard-body">
  <button class="nav-toggle" data-nav-toggle aria-label="Toggle menu">&#9776;</button>
  <div class="nav-overlay" data-nav-overlay></div>
  <div class="dashboard-wrap">
    <nav class="nav">
      <h2>🌱 Corpo Valley</h2>
      <div class="nav-user">${escapeHtml(email)}</div>
      ${navItems.map(n => `<a href="${escapeHtml(n.href)}"${activeNav === n.key ? ' class="active"' : ''}>${escapeHtml(n.label)}</a>`).join('\n')}
      ${adminNav}
      <div style="margin-top:auto; padding-top:2rem;">
        <a href="/logout">Log out</a>
      </div>
    </nav>
    <main class="main">
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
${SITE_FOOTER}
    </main>
  </div>
  <script nonce="${cspNonce()}">
    (function(){
      // Delegated handlers replace inline on* attributes so the CSP can drop
      // script-src 'unsafe-inline'.
      var nav = document.querySelector('.nav');
      var overlay = document.querySelector('[data-nav-overlay]');
      var toggle = document.querySelector('[data-nav-toggle]');
      if (toggle) toggle.addEventListener('click', function(){
        if (nav) nav.classList.toggle('open');
        if (overlay) overlay.classList.toggle('open');
      });
      if (overlay) overlay.addEventListener('click', function(){
        if (nav) nav.classList.remove('open');
        overlay.classList.remove('open');
      });
      // Confirm-on-submit for any form carrying data-confirm="message".
      document.addEventListener('submit', function(e){
        var form = e.target;
        if (form && form.getAttribute && form.hasAttribute('data-confirm')) {
          if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
        }
      });
      // Copy-to-clipboard for buttons carrying data-copy-target="<elementId>".
      document.addEventListener('click', function(e){
        var btn = e.target && e.target.closest ? e.target.closest('[data-copy-target]') : null;
        if (!btn) return;
        var el = document.getElementById(btn.getAttribute('data-copy-target'));
        if (!el || !navigator.clipboard) return;
        navigator.clipboard.writeText(el.innerText).then(function(){
          var o = btn.textContent;
          btn.textContent = 'Copied ✓';
          setTimeout(function(){ btn.textContent = o; }, 1500);
        });
      });
    })();
  </script>
</body>
</html>`;
}

// ── Projects ───────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  // The project's org-wide `everyone` grant per area ('none' = private to the
  // owner + explicit grantees). Drives the summary badge on the project card.
  everyoneSite: string;
  everyoneRepo: string;
  createdAt: string;
  giteaRepo?: string | null;
  // True when k8s/postgres.yaml exists in the project repo — the Database
  // card uses this to choose the enable vs. remove control.
  postgresEnabled?: boolean;
  // True when k8s/garage.yaml exists in the project repo — the Storage card
  // uses this to choose the enable vs. remove control.
  storageEnabled?: boolean;
  // Provisioning lifecycle: 'provisioning' | 'ready' | 'failed'. Cards in the
  // non-ready states show an "Initializing…" badge and their link lands on the
  // initializing screen.
  status: string;
}

// A project shared with the viewer via a grant, with their effective levels.
export interface SharedProjectRow extends ProjectRow {
  sitePerm: string;
  repoPerm: string;
}

export interface ProjectGrantRow {
  id: string;
  subject_type: string;
  subject_name: string | null;
  site_perm: string | null;
  repo_perm: string | null;
}

export interface GroupOptionRow {
  name: string;
  memberCount: number;
}

function accessBadge(value: string): string {
  return `<span class="badge badge-access">${escapeHtml(value)}</span>`;
}

// ── Community Feed ──────────────────────────────────────────

// The sort axes the feed offers. `created`/`updated` render newest-first;
// `creator` is alphabetical by email. Shared with routes/dashboard.ts so the
// route and template agree on the valid set.
export const COMMUNITY_SORTS = ['created', 'creator', 'updated'] as const;
export type CommunitySort = (typeof COMMUNITY_SORTS)[number];

// Sort direction. Validated by the route the same way `sort` is.
export const COMMUNITY_DIRS = ['asc', 'desc'] as const;
export type CommunityDir = (typeof COMMUNITY_DIRS)[number];

// The default direction for each axis when a user first clicks it: dates go
// newest-first (desc), creator goes A→Z (asc). Shared with the route so its
// default matches the affordance the header advertises.
export const COMMUNITY_DEFAULT_DIR: Record<CommunitySort, CommunityDir> = {
  created: 'desc',
  updated: 'desc',
  creator: 'asc',
};

export interface CommunityRow {
  name: string;
  slug: string;
  creator: string;   // owner email (or '—' if unresolved)
  sitePerm: string;  // the everyone site grant: 'read' | 'write'
  createdAt: string; // pre-formatted absolute date (tooltip)
  updatedAt: string; // pre-formatted absolute date (tooltip)
  createdRel: string; // relative "2d ago" label
  updatedRel: string; // relative "3w ago" label
}

export function renderCommunityFeed(
  email: string,
  rows: CommunityRow[],
  isAdmin: boolean,
  sort: CommunitySort,
  dir: CommunityDir,
): string {
  // A sortable column header. Clicking the ACTIVE column flips direction;
  // clicking another switches to it with that column's sensible default. The
  // active column shows ▲/▼ for its direction; inactive sortable columns show a
  // dim ⇅ so it's clear they can be sorted too. Project & Access are not
  // sortable and render as plain (.col-static) headers.
  const sortHeader = (key: CommunitySort, label: string) => {
    const active = sort === key;
    const nextDir: CommunityDir = active
      ? (dir === 'asc' ? 'desc' : 'asc')
      : COMMUNITY_DEFAULT_DIR[key];
    const caret = active
      ? `<span class="sort-caret" aria-hidden="true">${dir === 'asc' ? '▲' : '▼'}</span>`
      : `<span class="sort-caret sort-caret-idle" aria-hidden="true">⇅</span>`;
    const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return {
      ariaSort,
      html: `<a class="sort-link${active ? ' is-active' : ''}" href="/community?sort=${key}&dir=${nextDir}">${escapeHtml(label)}${caret}</a>`,
    };
  };

  let body = `
    <p class="tagline">Internal projects shared across the valley. Open one to see what folks are building.</p>
  `;

  if (rows.length === 0) {
    body += `
      <div class="app-card" style="text-align:center;padding:2rem 1.5rem;">
        <div style="font-size:2rem;margin-bottom:0.5rem;">🏘️</div>
        <h3 style="color:#fdf6e8;margin:0 0 0.35rem 0;">Nothing shared yet</h3>
        <p class="help" style="margin-bottom:0;">No internal projects are visible right now. When someone shares a project's site with everyone, it shows up here.</p>
      </div>
    `;
    return dashboardLayout('Community Feed', body, email, isAdmin, 'community');
  }

  const creatorH = sortHeader('creator', 'Creator');
  const createdH = sortHeader('created', 'Created');
  const updatedH = sortHeader('updated', 'Last updated');

  body += `
    <style>
      .cf-filter-wrap { margin: 1rem 0 0; }
      .cf-filter {
        width: 100%; max-width: 22rem; box-sizing: border-box;
        padding: 0.5rem 0.7rem; border-radius: 6px;
        border: 1px solid #5a4a36; background: #2a2118; color: #fdf6e8;
        font-size: 0.9rem;
      }
      .cf-filter::placeholder { color: #a89878; }
      .cf-filter:focus { outline: none; border-color: #e8b94a; }
      .table th.col-static { color: #8a7a5e; font-weight: 600; }
      .table th .sort-link { color: #c4b698; display: inline-flex; align-items: center; gap: 0.3rem; }
      .table th .sort-link:hover { color: #e8b94a; text-decoration: none; }
      .table th .sort-link.is-active { color: #e8b94a; }
      .sort-caret { font-size: 0.7rem; }
      .sort-caret-idle { color: #6f5e44; }
      .table th .sort-link:hover .sort-caret-idle { color: #c4b698; }
      .table tr.cf-row { cursor: pointer; }
      .table tr.cf-row:hover td { background: #3a2e22; }
      .cf-nomatch { display: none; }
      .cf-nomatch td { color: #a89878; text-align: center; padding: 1.5rem 0.75rem; font-style: italic; }
    </style>
    <div class="cf-filter-wrap">
      <input type="text" id="cf-filter" class="cf-filter" placeholder="Filter by project or creator…"
             aria-label="Filter projects by name or creator" autocomplete="off">
    </div>
    <div class="table-wrap"><table class="table" id="cf-table">
      <thead><tr>
        <th class="col-static">Project</th>
        <th class="col-static">Access</th>
        <th aria-sort="${creatorH.ariaSort}">${creatorH.html}</th>
        <th aria-sort="${createdH.ariaSort}">${createdH.html}</th>
        <th aria-sort="${updatedH.ariaSort}">${updatedH.html}</th>
      </tr></thead>
      <tbody>`;
  for (const r of rows) {
    const host = `${escapeHtml(r.slug)}.${escapeHtml(PROJECTS_DOMAIN)}`;
    const siteUrl = projectSiteUrl(escapeHtml(r.slug));
    body += `
        <tr class="cf-row" data-href="${siteUrl}" data-name="${escapeHtml(r.name)}" data-creator="${escapeHtml(r.creator)}">
          <td>
            <a href="${siteUrl}" target="_blank" rel="noopener">${escapeHtml(r.name)} ↗</a>
            <div class="help" style="margin:0;">${host}</div>
          </td>
          <td>${accessBadge(r.sitePerm)}</td>
          <td>${escapeHtml(r.creator)}</td>
          <td><span title="${escapeHtml(r.createdAt)}">${escapeHtml(r.createdRel)}</span></td>
          <td><span title="${escapeHtml(r.updatedAt)}">${escapeHtml(r.updatedRel)}</span></td>
        </tr>`;
  }
  body += `
        <tr class="cf-nomatch"><td colspan="5">No projects match your filter.</td></tr>
      </tbody></table></div>
    <script nonce="${cspNonce()}">
      (function(){
        var input = document.getElementById('cf-filter');
        var table = document.getElementById('cf-table');
        if (!table) return;
        var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr.cf-row'));
        var noMatch = table.querySelector('tbody tr.cf-nomatch');

        // Live client-side filter on project name OR creator (case-insensitive).
        if (input) {
          input.addEventListener('input', function(){
            var q = input.value.trim().toLowerCase();
            var shown = 0;
            rows.forEach(function(tr){
              var name = (tr.getAttribute('data-name') || '').toLowerCase();
              var creator = (tr.getAttribute('data-creator') || '').toLowerCase();
              var hit = !q || name.indexOf(q) !== -1 || creator.indexOf(q) !== -1;
              tr.style.display = hit ? '' : 'none';
              if (hit) shown++;
            });
            if (noMatch) noMatch.style.display = shown === 0 ? 'table-row' : 'none';
          });
        }

        // Whole-row click opens the project site in a new tab. Real links and
        // text selections are left alone.
        rows.forEach(function(tr){
          tr.addEventListener('click', function(ev){
            if (ev.target.closest('a')) return;
            var sel = window.getSelection && window.getSelection();
            if (sel && String(sel).length) return;
            var href = tr.getAttribute('data-href');
            if (href) window.open(href, '_blank', 'noopener');
          });
        });
      })();
    </script>`;

  return dashboardLayout('Community Feed', body, email, isAdmin, 'community');
}

export function renderProjects(
  email: string,
  projects: ProjectRow[],
  isAdmin: boolean,
  shared: SharedProjectRow[] = []
): string {
  let body = `
    <p class="tagline">Your patch of the valley — every app starts as a project.${isAdmin ? ` ${roleBadge(true)}` : ''}</p>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.25rem;">
      <a href="/projects/new" class="btn btn-primary">Plant a new project</a>
      <a href="/connect" class="btn btn-secondary">Connect Claude Code</a>
    </div>
  `;

  if (projects.length === 0) {
    body += `
      <div class="app-card" style="text-align:center;padding:2rem 1.5rem;">
        <div style="font-size:2rem;margin-bottom:0.5rem;">🌱</div>
        <h3 style="color:#fdf6e8;margin:0 0 0.35rem 0;">Nothing planted yet</h3>
        <p class="help" style="margin-bottom:1rem;">A project gives you a repo, a CI pipeline, and a deployed URL in under a minute. Or connect Claude Code first and ask it to plant one for you.</p>
        <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
          <a href="/projects/new" class="btn btn-primary">Plant a project</a>
          <a href="/connect" class="btn btn-secondary">Connect Claude Code</a>
        </div>
      </div>
    `;
  } else {
    body += '<div class="app-grid">';
    for (const p of projects) {
      const url = projectSiteUrl(escapeHtml(p.slug));
      body += `
        <div class="app-card">
          <div class="app-card-header">
            <span class="app-card-name">${escapeHtml(p.name)}</span>
          </div>
          <div class="app-card-sub"><a href="${url}" target="_blank" rel="noopener" style="color:#e8b94a;">${escapeHtml(p.slug)}.${escapeHtml(PROJECTS_DOMAIN)} ↗</a></div>
          <div class="app-card-sub" style="margin-top:0.4rem;">${(p.everyoneSite === 'none' && p.everyoneRepo === 'none')
            ? accessBadge('private')
            : `Everyone: site ${accessBadge(p.everyoneSite)} &nbsp; repo ${accessBadge(p.everyoneRepo)}`}${p.status !== 'ready'
            ? ` &nbsp; <span class="badge badge-access" style="background:#3a3120;color:#e8d39a;">${p.status === 'failed' ? 'Provisioning failed' : 'Initializing…'}</span>`
            : ''}</div>
          <div class="app-card-actions">
            <a href="/projects/${escapeHtml(p.id)}" class="btn btn-secondary">${p.status !== 'ready' ? 'View' : 'Edit'}</a>
            ${p.giteaRepo
              ? `<a href="${GITEA_PUBLIC_URL}/${escapeHtml(p.giteaRepo)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Repo ↗</a>`
              : ''}
          </div>
        </div>`;
    }
    body += '</div>';
  }

  if (shared.length > 0) {
    body += `
      <h3 style="color:#fdf6e8;margin-top:2rem;">Shared with you</h3>
      <p class="help">Projects other members granted you (or one of your groups) access to.</p>
      <div class="app-grid">`;
    for (const p of shared) {
      const url = projectSiteUrl(escapeHtml(p.slug));
      body += `
        <div class="app-card">
          <div class="app-card-header">
            <span class="app-card-name">${escapeHtml(p.name)}</span>
          </div>
          <div class="app-card-sub"><a href="${url}" target="_blank" rel="noopener" style="color:#e8b94a;">${escapeHtml(p.slug)}.${escapeHtml(PROJECTS_DOMAIN)} ↗</a></div>
          <div class="app-card-sub" style="margin-top:0.4rem;">Your access: site ${accessBadge(p.sitePerm)} &nbsp; repo ${accessBadge(p.repoPerm)}</div>
          ${p.giteaRepo && p.repoPerm !== 'none'
            ? `<div class="app-card-actions"><a href="${GITEA_PUBLIC_URL}/${escapeHtml(p.giteaRepo)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Repo ↗</a></div>`
            : ''}
        </div>`;
    }
    body += '</div>';
  }

  return dashboardLayout('Projects', body, email, isAdmin, 'projects');
}

// The "project initializing" screen shown right after async creation (POST
// /projects redirects here) and on any open of a project whose status is not
// yet `ready`. The user can wait — we auto-redirect to the detail page the
// moment provisioning completes — or head back to the portal.
//
// Auto-redirect to ready works two ways, belt-and-suspenders:
//   - No-JS fallback: <meta http-equiv="refresh"> reloads THIS same
//     /projects/:id URL every 5s; once status is `ready` the route renders the
//     real detail page instead of this screen.
//   - With JS: a nonce'd inline script polls /projects/:id/status every ~2.5s
//     and sets location.href to the detail URL as soon as it sees `ready`.
// `failed` renders an error state and does NOT auto-poll/refresh.
//
// statusOverride lets callers/tests force a state without a full ProjectRow
// round-trip; otherwise the project's own status is used.
export function renderProjectInitializing(
  email: string,
  isAdmin: boolean,
  project: ProjectRow,
  statusOverride?: string,
): string {
  const status = statusOverride ?? project.status;
  const failed = status === 'failed';
  const detailUrl = `/projects/${escapeHtml(project.id)}`;
  const statusUrl = `/projects/${encodeURIComponent(project.id)}/status`;

  let body = `
    <style>
      .init-card { max-width: 34rem; margin: 2rem auto; text-align: center; padding: 2.5rem 2rem; }
      .init-spinner {
        width: 3rem; height: 3rem; margin: 0.5rem auto 1.5rem;
        border: 4px solid #4a3c2c; border-top-color: #e8b94a; border-radius: 50%;
        animation: init-spin 0.9s linear infinite;
      }
      @keyframes init-spin { to { transform: rotate(360deg); } }
      .init-card h2 { color: #fdf6e8; margin: 0 0 0.5rem 0; }
      .init-actions { margin-top: 1.75rem; }
    </style>
  `;

  if (failed) {
    body += `
      <div class="app-card init-card">
        <h2>🌱 ${escapeHtml(project.name)}</h2>
        <div class="message error" style="text-align:left;">Provisioning hit a snag — the platform will keep retrying in the background.</div>
        <div class="init-actions">
          <a href="/" class="btn btn-secondary">← Back to projects</a>
        </div>
      </div>
    `;
    return dashboardLayout('Initializing', body, email, isAdmin, 'projects');
  }

  body += `
    <div class="app-card init-card">
      <div class="init-spinner" aria-hidden="true"></div>
      <h2>🌱 Planting ${escapeHtml(project.name)}…</h2>
      <p class="help">Setting up your repo, deployment, and live URL. This usually takes under a minute — you can wait here or head back; we'll keep building.</p>
      <div class="init-actions">
        <a href="/" class="btn btn-secondary">← Back to projects</a>
      </div>
    </div>
    <script nonce="${cspNonce()}">
      (function(){
        var statusUrl = ${JSON.stringify(statusUrl)};
        var detailUrl = ${JSON.stringify(detailUrl)};
        function poll(){
          fetch(statusUrl, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
            .then(function(r){ return r.ok ? r.json() : null; })
            .then(function(j){
              if (j && j.status === 'ready') { window.location.href = detailUrl; return; }
              setTimeout(poll, 2500);
            })
            .catch(function(){ setTimeout(poll, 2500); });
        }
        setTimeout(poll, 2500);
      })();
    </script>
  `;

  // No-JS fallback: reload this same URL, which renders the detail page once
  // the project is ready. (Injected into <head> via the meta hook below.)
  return dashboardLayout('Initializing', body, email, isAdmin, 'projects', {
    headExtra: '<meta http-equiv="refresh" content="5">',
  });
}

// Grant levels for the SITE/PROJECT facet and the REPO facet. Both areas
// support all three; the org-wide "Everyone" subject is capped at read/write
// (enforced server-side) and is offered admin nowhere in the UI.
const GRANT_LEVEL_OPTS = ['read', 'write', 'admin'];

function selectOptions(opts: string[], selected: string): string {
  return opts.map(o => `<option value="${escapeHtml(o)}"${o === selected ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
}

export function renderProjectCreate(
  email: string,
  isAdmin: boolean,
  csrf: string = '',
  errorMessage: string = '',
  prefill: { slug?: string; name?: string; visibility?: string; database?: boolean; storage?: boolean; mcp?: boolean } = {}
): string {
  const errorBanner = errorMessage
    ? `<div class="message error" style="margin-bottom:1rem;">${escapeHtml(errorMessage)}</div>`
    : '';

  // Two postures at create time: Private (owner-only) or Internal (org-wide
  // write). Finer access — per-user/group grants, read-only org-wide — is
  // managed from the project page after creation.
  const preset = prefill.visibility === 'internal' ? 'internal' : 'private';

  const radio = (val: string, title: string, desc: string) => `
    <label class="visibility-option${preset === val ? ' selected' : ''}" data-value="${val}">
      <input type="radio" name="visibility" value="${val}"${preset === val ? ' checked' : ''} style="margin-right:0.5rem;">
      <span style="font-weight:600;color:#fdf6e8;">${escapeHtml(title)}</span>
      <span style="display:block;font-size:0.8rem;color:#a89878;margin-left:1.5rem;">${escapeHtml(desc)}</span>
    </label>
  `;

  // A project is its website plus any capabilities the user checks. The
  // website is always on (shown checked + disabled); database, storage, and MCP
  // are optional layers the platform composes into the repo.
  const capCheckbox = (name: string, checked: boolean, disabled: boolean, title: string, desc: string) => `
    <label class="visibility-option${checked ? ' selected' : ''}" data-cap="${name}">
      <input type="checkbox" name="${name}" value="on"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''} style="margin-right:0.5rem;">
      <span style="font-weight:600;color:#fdf6e8;">${escapeHtml(title)}</span>
      <span style="display:block;font-size:0.8rem;color:#a89878;margin-left:1.5rem;">${escapeHtml(desc)}</span>
    </label>
  `;

  const body = `
    <p style="margin-bottom:1rem;"><a href="/" class="btn btn-secondary btn-sm">← All projects</a></p>
    ${errorBanner}

    <div class="app-card">
      <h2 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1.4rem;">Plant a new project</h2>
      <p class="help" style="margin-bottom:1.25rem;">A project is a Gitea repo, an auto-deployed site at <code>&lt;slug&gt;.${escapeHtml(PROJECTS_DOMAIN)}</code>, and the wiring to point Claude Code at it.</p>

      <form method="POST" action="/projects" id="cv-project-form">
        ${csrf}

        <div class="field">
          <label for="name">What are you building?</label>
          <input type="text" name="name" id="name" value="${escapeHtml(prefill.name || '')}" required
                 placeholder="My farm stand"
                 autofocus>
          <p class="help" style="margin-top:0.4rem;">
            Your URL will be <code><span id="cv-slug-display" style="color:#e8b94a;">&lt;slug&gt;</span>.${escapeHtml(PROJECTS_DOMAIN)}</code>
            <a href="#" id="cv-slug-edit" style="margin-left:0.5rem;color:#a89878;font-size:0.8rem;">edit slug</a>
          </p>
          <div id="cv-slug-wrap" style="display:${prefill.slug ? 'block' : 'none'};margin-top:0.5rem;">
            <input type="text" name="slug" id="slug" value="${escapeHtml(prefill.slug || '')}"
                   pattern="[a-z0-9-]+" title="Lowercase letters, digits, and hyphens only."
                   placeholder="my-farm-stand"
                   style="font-family:monospace;">
            <p class="help" style="margin-top:0.25rem;">Lowercase letters, digits, hyphens — max 63 chars.</p>
          </div>
        </div>

        <div class="field">
          <label>What should it do?</label>
          <div style="display:flex;flex-direction:column;gap:0.4rem;">
            ${capCheckbox('website', true, true, 'A website for people to view content', 'Always included. Served at the root of your URL.')}
            ${capCheckbox('database', !!prefill.database, false, 'Data/views are shared across users', 'Adds a private database and a /api endpoint so people can save and share data.')}
            ${capCheckbox('storage', !!prefill.storage, false, 'File storage for uploads', 'Adds a private S3-compatible store and a /files endpoint so people can upload and download files.')}
            ${capCheckbox('mcp', !!prefill.mcp, false, 'Users can connect to this project via MCP', 'Adds an /mcp endpoint so AI agents can use this project as a tool.')}
          </div>
        </div>

        <div class="field">
          <label>Who can see it?</label>
          <div id="cv-visibility-group" style="display:flex;flex-direction:column;gap:0.4rem;">
            ${radio('private', 'Private', 'Only you (and your bot). Grant individual members, groups, or everyone access later from the project page.')}
            ${radio('internal', 'Internal', 'Every Corpo Valley member can view the deployed site (read-only). No repo or code access — grant that to specific people or groups afterward. Still sign-in-gated — Corpo Valley does not publish projects publicly.')}
          </div>
          <p class="help" style="margin-top:0.4rem;">You can fine-tune access — per-user/group grants, read-only org-wide, admins — from the project page once it exists.</p>
        </div>

        <button type="submit" class="btn btn-primary" style="width:auto;">Plant it</button>
      </form>
    </div>

    <style>
      .visibility-option {
        display: block; padding: 0.6rem 0.75rem;
        border: 1px solid #5a4a36; border-radius: 6px;
        background: #2b2118; cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .visibility-option:hover { border-color: #84a25a; }
      .visibility-option.selected { border-color: #e8b94a; background: #3a3120; }
    </style>

    <script nonce="${cspNonce()}">
      (function(){
        var name = document.getElementById('name');
        var slugInput = document.getElementById('slug');
        var slugDisplay = document.getElementById('cv-slug-display');
        var slugWrap = document.getElementById('cv-slug-wrap');
        var slugEdit = document.getElementById('cv-slug-edit');
        var manuallyEdited = !!(slugInput && slugInput.value);
        function sluggify(s){
          return (s||'').toLowerCase()
            .replace(/[^a-z0-9]+/g,'-')
            .replace(/^-+|-+$/g,'')
            .slice(0,63);
        }
        function update(){
          var auto = sluggify(name && name.value);
          if (!manuallyEdited && slugInput) slugInput.value = auto;
          slugDisplay.textContent = (manuallyEdited && slugInput ? slugInput.value : auto) || '<slug>';
        }
        name && name.addEventListener('input', update);
        slugInput && slugInput.addEventListener('input', function(){
          manuallyEdited = true;
          slugDisplay.textContent = slugInput.value || '<slug>';
        });
        slugEdit && slugEdit.addEventListener('click', function(e){
          e.preventDefault();
          slugWrap.style.display = 'block';
          slugInput && slugInput.focus();
        });
        update();

        var opts = document.querySelectorAll('.visibility-option');
        opts.forEach(function(o){
          var r = o.querySelector('input[type=radio]');
          if (!r) return;
          r.addEventListener('change', function(){
            // Only deselect siblings in the same radio group (same name
            // attribute), so the template selector does not reset the
            // visibility one (and vice versa).
            var group = document.querySelectorAll(
              '.visibility-option input[type=radio][name="' + r.name + '"]'
            );
            group.forEach(function(g){
              var card = g.closest('.visibility-option');
              if (card) card.classList.remove('selected');
            });
            o.classList.add('selected');
          });
          o.addEventListener('click', function(ev){
            if (ev.target.tagName === 'INPUT') return;
            r.checked = true;
            r.dispatchEvent(new Event('change'));
          });
        });

        // Capability checkboxes: toggle the .selected highlight to match the
        // checkbox state (disabled boxes like the always-on website stay put).
        document.querySelectorAll('.visibility-option[data-cap]').forEach(function(o){
          var c = o.querySelector('input[type=checkbox]');
          if (!c) return;
          function sync(){ o.classList.toggle('selected', c.checked); }
          c.addEventListener('change', sync);
          o.addEventListener('click', function(ev){
            if (ev.target.tagName === 'INPUT' || c.disabled) return;
            c.checked = !c.checked;
            sync();
          });
        });
      })();
    </script>
  `;
  return dashboardLayout('New Project', body, email, isAdmin, 'projects');
}

export interface ProjectSecretRow {
  // Secret name = filename without `.sealed.yaml`.
  name: string;
}

export function renderProjectDetail(
  email: string,
  isAdmin: boolean,
  project: ProjectRow,
  csrf: string = '',
  secrets: ProjectSecretRow[] = [],
  secretMessage: { type: 'error' | 'success'; text: string } | null = null,
  grants: ProjectGrantRow[] = [],
  groups: GroupOptionRow[] = []
): string {
  const secretsList = secrets.length === 0
    ? '<div class="message info">No secrets yet.</div>'
    : `<div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th></th></tr></thead>
        <tbody>
        ${secrets.map((s) => `
          <tr>
            <td><code>${escapeHtml(s.name)}</code></td>
            <td>
              <form method="POST"
                    action="/projects/${escapeHtml(project.id)}/secrets/${escapeHtml(s.name)}/delete"
                    class="inline-form"
                    data-confirm="Delete sealed secret ${escapeHtml(s.name)}? This removes it from your repo on the next sync.">
                ${csrf}
                <button type="submit" class="btn btn-danger btn-sm">Delete</button>
              </form>
            </td>
          </tr>
        `).join('')}
        </tbody></table></div>`;

  const msgBanner = secretMessage
    ? `<div class="message ${secretMessage.type}">${escapeHtml(secretMessage.text)}</div>`
    : '';

  const cloneCommands = project.giteaRepo
    ? `git clone ${GITEA_PUBLIC_URL}/${escapeHtml(project.giteaRepo)}.git
cd ${escapeHtml(project.slug)}
claude`
    : '';

  // ── Overview card: name + live URL as the focal point; repo + created
  // are secondary metadata below.
  const overviewCard = `
    <div class="app-card">
      <h2 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1.4rem;">${escapeHtml(project.name)}</h2>
      <div style="margin-bottom:0.5rem;">
        <a href="${projectSiteUrl(escapeHtml(project.slug))}" target="_blank" rel="noopener" style="color:#e8b94a;font-size:0.95rem;">
          ${escapeHtml(project.slug)}.${escapeHtml(PROJECTS_DOMAIN)} ↗
        </a>
      </div>
      <div style="font-size:0.8rem;color:#a89878;">
        ${project.giteaRepo
          ? `<a href="${GITEA_PUBLIC_URL}/${escapeHtml(project.giteaRepo)}" target="_blank" rel="noopener" style="color:#a89878;text-decoration:underline;">${escapeHtml(project.giteaRepo)}</a> · `
          : ''}Created ${escapeHtml(project.createdAt)} · <code>${escapeHtml(project.slug)}</code>
      </div>
    </div>
  `;

  // ── Get Started card: two paths — the agent-driven MCP flow
  // (recommended) and the manual clone+claude path. Tabbed so a fresh
  // user picks one without paralysis.
  const mcpAddCmd = `claude mcp add --transport http corpo-valley ${MCP_URL}`;
  const mcpFirstPrompt = `Use Corpo Valley. Open the ${project.slug} project and add a homepage with our name and a sign-up form.`;
  const getStartedCard = project.giteaRepo ? `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">Get started</h3>
      <p class="help" style="margin-bottom:0.85rem;">Your project is planted. Two ways to start building — pick one:</p>

      <div class="cv-tabs">
        <div class="cv-tab-row" role="tablist">
          <button type="button" class="cv-tab active" data-tab="mcp" role="tab">Connect Claude Code (recommended)</button>
          <button type="button" class="cv-tab" data-tab="manual" role="tab">Clone &amp; code locally</button>
        </div>

        <div class="cv-tab-panel" data-panel="mcp">
          <p class="help" style="margin-bottom:0.6rem;"><strong style="color:#fdf6e8;">1.</strong> Add Corpo Valley to Claude Code (or Cursor, or Codex — see <a href="/docs/mcp" style="color:#e8b94a;">/docs/mcp</a> for the others).</p>
          <pre class="snippet" id="cv-mcp-add">${escapeHtml(mcpAddCmd)}</pre>
          <button type="button" class="btn btn-sm btn-secondary cv-copy" data-target="cv-mcp-add" style="margin-top:0.4rem;">Copy command</button>
          <p class="help" style="margin-top:0.6rem;">Your editor opens a browser the first time to sign in — same login as the portal — and tokens land back in the editor.</p>

          <p class="help" style="margin:1rem 0 0.4rem 0;"><strong style="color:#fdf6e8;">2.</strong> Open Claude Code and try this prompt:</p>
          <pre class="snippet" id="cv-mcp-prompt">${escapeHtml(mcpFirstPrompt)}</pre>
          <button type="button" class="btn btn-sm btn-secondary cv-copy" data-target="cv-mcp-prompt" style="margin-top:0.4rem;">Copy prompt</button>
          <p class="help" style="margin-top:0.75rem;margin-bottom:0;">The agent will use the <code>get_gitea_credentials</code> tool to clone, then code in place. You don't need a terminal.</p>
        </div>

        <div class="cv-tab-panel" data-panel="manual" hidden>
          <p class="help" style="margin-bottom:0.6rem;"><strong style="color:#fdf6e8;">1.</strong> Open it on your machine:</p>
          <pre class="snippet" id="cv-clone-cmd">${escapeHtml(cloneCommands)}</pre>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem;">
            <button type="button" class="btn btn-sm btn-secondary cv-copy" data-target="cv-clone-cmd">Copy commands</button>
            <form method="POST" action="/projects/${escapeHtml(project.id)}/cli-token" class="inline-form" style="display:inline;">
              ${csrf}
              <button type="submit" class="btn btn-sm btn-primary">Get a CLI password</button>
            </form>
          </div>
          <p class="help" style="margin-top:0.75rem;margin-bottom:0;">First clone needs a Gitea password — click <strong>Get a CLI password</strong> and Corpo Valley hands you a one-shot token with a ready-to-paste clone command.</p>

          <p class="help" style="margin:1rem 0 0.4rem 0;"><strong style="color:#fdf6e8;">2.</strong> Talk to Claude in your project: <em>"Build a homepage with our name and a sign-up form."</em></p>
        </div>
      </div>
    </div>
    <style>
      .cv-tabs { margin-top: 0.25rem; }
      .cv-tab-row { display:flex; gap:0.4rem; border-bottom:1px solid #5a4a36; margin-bottom:0.75rem; flex-wrap:wrap; }
      .cv-tab { background:none; border:none; padding:0.5rem 0.75rem; cursor:pointer; color:#a89878; font-size:0.85rem; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s, border-color .15s; }
      .cv-tab:hover { color:#fdf6e8; }
      .cv-tab.active { color:#fdf6e8; border-bottom-color:#e8b94a; }
      .cv-tab-panel[hidden] { display:none; }
    </style>
    <script nonce="${cspNonce()}">
      (function(){
        var tabs = document.querySelectorAll('.cv-tabs .cv-tab');
        var panels = document.querySelectorAll('.cv-tabs .cv-tab-panel');
        tabs.forEach(function(t){
          t.addEventListener('click', function(){
            var k = t.getAttribute('data-tab');
            tabs.forEach(function(x){ x.classList.toggle('active', x === t); });
            panels.forEach(function(p){
              if (p.getAttribute('data-panel') === k) p.removeAttribute('hidden');
              else p.setAttribute('hidden', 'hidden');
            });
          });
        });
        document.querySelectorAll('.cv-tabs .cv-copy').forEach(function(b){
          b.addEventListener('click', function(){
            var el = document.getElementById(b.getAttribute('data-target'));
            if (!el) return;
            navigator.clipboard.writeText(el.innerText).then(function(){
              var prev = b.textContent;
              b.textContent = 'Copied ✓';
              setTimeout(function(){ b.textContent = prev; }, 1500);
            });
          });
        });
      })();
    </script>
  ` : '';

  // ── Share panel: a people-centric "Manage access" view (Google Docs / GitHub
  // style) over the same grant model. Three parts: General access (the
  // org-wide "Everyone" subject → Private vs Internal), a People-with-access
  // list (one row per user/group grant, Site + Repo levels both editable
  // inline), and one unified Add form. All wired to the existing
  // /access + /access/:id/revoke endpoints.
  const accessAction = `/projects/${escapeHtml(project.id)}/access`;

  // A compact <select> that POSTs a single facet on change (none = revoke).
  // Used for inline edits in the people list and the general-access control.
  const facetSelect = (opts: {
    name: string; facet: 'site' | 'repo'; current: string | null;
    subjectType: string; identifier?: string | null; allowAdmin?: boolean; label: string;
  }) => {
    const levels = opts.allowAdmin === false ? ['read', 'write'] : ['read', 'write', 'admin'];
    const cur = opts.current || 'none';
    const options = [`<option value="none"${cur === 'none' ? ' selected' : ''}>No access</option>`]
      .concat(levels.map((l) => `<option value="${l}"${cur === l ? ' selected' : ''}>${l}</option>`))
      .join('');
    return `
      <form method="POST" action="${accessAction}" class="js-facet-form inline-form" style="display:inline;">
        ${csrf}
        <input type="hidden" name="subject_type" value="${escapeHtml(opts.subjectType)}">
        ${opts.identifier != null ? `<input type="hidden" name="identifier" value="${escapeHtml(opts.identifier)}">` : ''}
        <input type="hidden" name="facet" value="${escapeHtml(opts.facet)}">
        <label class="share-select-label">${escapeHtml(opts.label)}
          <select name="level" class="js-facet-select">${options}</select>
        </label>
        <noscript><button type="submit" class="btn btn-secondary btn-sm">Set</button></noscript>
      </form>`;
  };

  // General access (Everyone). Private = no everyone grant (or all-null);
  // Internal = everyone has a site read/write grant.
  const everyone = grants.find((g) => g.subject_type === 'everyone');
  const everyoneSite = everyone?.site_perm ?? null;
  const isInternal = everyoneSite === 'read' || everyoneSite === 'write';
  const generalAccess = `
    <div class="share-general">
      <div class="share-general-icon" aria-hidden="true">${isInternal ? '🌐' : '🔒'}</div>
      <div class="share-general-text">
        <div class="share-general-title">${isInternal ? 'Internal' : 'Private'}</div>
        <div class="help" style="margin:0;">${isInternal
          ? `Anyone signed in can view the site (${escapeHtml(everyoneSite!)}).`
          : 'Only you, your bot, and the people you add below can reach it.'}</div>
      </div>
      <div class="share-general-control">
        ${facetSelect({
          name: 'everyone', facet: 'site', current: everyoneSite,
          subjectType: 'everyone', allowAdmin: false, label: 'General access',
        })}
      </div>
    </div>`;

  // People list — one row per non-everyone grant, Site + Repo both editable.
  const people = grants.filter((g) => g.subject_type !== 'everyone');
  const personRow = (g: ProjectGrantRow) => `
    <div class="share-person">
      <div class="share-person-id">
        <span class="share-person-name">${escapeHtml(g.subject_name || '(unknown)')}</span>
        <span class="badge badge-access share-person-type">${escapeHtml(g.subject_type)}</span>
      </div>
      <div class="share-person-perms">
        ${facetSelect({ name: 'site', facet: 'site', current: g.site_perm, subjectType: g.subject_type, identifier: g.subject_name, label: 'Site' })}
        ${facetSelect({ name: 'repo', facet: 'repo', current: g.repo_perm, subjectType: g.subject_type, identifier: g.subject_name, label: 'Repo' })}
        <form method="POST" action="/projects/${escapeHtml(project.id)}/access/${escapeHtml(g.id)}/revoke" class="inline-form" style="display:inline;"
              data-confirm="Remove ${escapeHtml(g.subject_name || 'this subject')}'s access entirely?">
          ${csrf}
          <input type="hidden" name="all" value="true">
          <button type="submit" class="share-remove" title="Remove access" aria-label="Remove ${escapeHtml(g.subject_name || 'subject')}">&times;</button>
        </form>
      </div>
    </div>`;
  const peopleList = people.length
    ? `<div class="share-people">${people.map(personRow).join('')}</div>`
    : `<p class="help share-empty">Just you and your bot — no one else has access yet.</p>`;

  // Unified add form — one identifier + Site/Repo level pickers (submitted as
  // site_level/repo_level so a single POST can set both areas at once).
  const noneFirst = () =>
    [`<option value="none" selected>No access</option>`]
      .concat(['read', 'write', 'admin'].map((l) => `<option value="${l}">${l}</option>`))
      .join('');
  const addForm = `
    <form method="POST" action="${accessAction}" class="share-add">
      ${csrf}
      <div class="share-add-row">
        <div class="field" style="margin:0;">
          <label for="share-subject-type">Type</label>
          <select id="share-subject-type" name="subject_type" class="js-add-subject">
            <option value="user">user</option>
            <option value="group">group</option>
          </select>
        </div>
        <div class="field js-add-id-wrap" style="margin:0;flex:2;min-width:12rem;">
          <label for="share-identifier">Email / username / group name</label>
          <input type="text" id="share-identifier" name="identifier" class="js-add-id"
                 placeholder="alice@example.com or platform-team" autocomplete="off">
        </div>
        <div class="field" style="margin:0;">
          <label for="share-site-level">Site</label>
          <select id="share-site-level" name="site_level">${noneFirst()}</select>
        </div>
        <div class="field" style="margin:0;">
          <label for="share-repo-level">Repo</label>
          <select id="share-repo-level" name="repo_level">${noneFirst()}</select>
        </div>
        <button type="submit" class="btn btn-primary btn-sm">Add</button>
      </div>
      <p class="help" style="margin:0.4rem 0 0;">Pick a level for Site, Repo, or both. <strong>Site</strong> is the deployed website; <strong>Repo</strong> is the Gitea source. The highest applicable level wins; you always have admin on both.</p>
    </form>`;

  // ── Configure card: Sealed Secrets + Access settings, grouped because
  // both are "settings on the running project". Sub-sections inside the
  // card use `<h4>` so they're visually subordinate to the card header.
  const configureCard = `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">Configure</h3>
      <p class="help" style="margin-bottom:1rem;">Settings that travel with your running project.</p>
      ${msgBanner}

      <h4 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:0.95rem;">Sealed secrets</h4>
      <p class="help" style="margin-bottom:0.6rem;">Sealed in-cluster, committed to <code>k8s/secrets/&lt;name&gt;.sealed.yaml</code> in your repo; materialised as Kubernetes Secrets in the <code>${escapeHtml(project.slug)}</code> namespace. Reference from your Deployment via <code>envFrom</code> or <code>valueFrom: secretKeyRef</code>.</p>
      ${secretsList}
      <form method="POST" action="/projects/${escapeHtml(project.id)}/secrets" style="margin-top:0.85rem;">
        ${csrf}
        <div class="field">
          <label for="secret_name">New secret name</label>
          <input type="text" id="secret_name" name="secret_name" required
                 pattern="[a-z0-9-]+"
                 title="lowercase letters, digits, and hyphens"
                 placeholder="api-credentials" />
        </div>
        <div class="field">
          <label for="secret_data">Data (one <code>KEY=VALUE</code> per line)</label>
          <textarea id="secret_data" name="secret_data" rows="4" required
                    placeholder="API_KEY=hunter2&#10;DB_PASSWORD=correct horse battery staple"
                    style="width:100%; font-family:monospace; padding:0.5rem;"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Seal &amp; save</button>
      </form>

      <hr style="border:none;border-top:1px solid #5a4a36;margin:1.5rem 0 1rem 0;" />

      <h4 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:0.95rem;">Share</h4>
      <p class="help" style="margin-bottom:0.85rem;"><strong>Private by default</strong> — only you and your bot can reach this project. Add people below, or open the site to everyone signed in.</p>

      <div class="share-block-label">General access</div>
      ${generalAccess}

      <div class="share-block-label" style="margin-top:1.1rem;">People with access</div>
      ${peopleList}

      <div class="share-block-label" style="margin-top:1.1rem;">Add people</div>
      ${addForm}

      ${groups.length > 0
        ? `<p class="help" style="margin-top:0.85rem;">Tip: add a <strong>group</strong> by name to grant many members at once. Groups: ${groups.map((g) => `<code>${escapeHtml(g.name)}</code> (${g.memberCount})`).join(', ')} — manage under <a href="/groups" style="color:#e8b94a;">Groups</a>.</p>`
        : `<p class="help" style="margin-top:0.85rem;">Tip: create a <a href="/groups" style="color:#e8b94a;">group</a> to grant many members at once, then add it by name above.</p>`}

      <details class="share-dev">
        <summary>For developers</summary>
        <p class="help" style="margin:0.5rem 0 0;"><strong>Site</strong> levels are surfaced to your code as the <code>X-CV-Perm</code> header (read &lt; write &lt; admin); without read the request is blocked at the edge. <strong>Repo</strong> levels map onto Gitea collaborator permissions on the project&rsquo;s source repository.</p>
      </details>

      <style>
        .share-block-label { font-size:0.78rem; text-transform:uppercase; letter-spacing:0.04em; color:#a89878; margin-bottom:0.4rem; font-weight:600; }
        .share-general { display:flex; align-items:center; gap:0.75rem; background:#3a3120; border:1px solid #5a4a36; border-radius:8px; padding:0.65rem 0.85rem; }
        .share-general-icon { font-size:1.3rem; line-height:1; }
        .share-general-text { flex:1; min-width:0; }
        .share-general-title { font-weight:600; color:#fdf6e8; font-size:0.95rem; }
        .share-general-control { flex-shrink:0; }
        .share-select-label { display:inline-flex; align-items:center; gap:0.35rem; margin:0; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; color:#a89878; font-weight:600; }
        .share-people { display:flex; flex-direction:column; gap:0.4rem; }
        .share-person { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; background:#3a3120; border:1px solid #5a4a36; border-radius:8px; padding:0.5rem 0.75rem; flex-wrap:wrap; }
        .share-person-id { display:flex; align-items:center; gap:0.5rem; min-width:0; }
        .share-person-name { color:#fdf6e8; font-size:0.9rem; word-break:break-all; }
        .share-person-type { flex-shrink:0; }
        .share-person-perms { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; }
        .share-remove { background:none; border:none; color:#cc9988; cursor:pointer; font-size:1.15rem; line-height:1; padding:0 0.15rem; }
        .share-remove:hover { color:#f3a5a5; }
        .share-empty { background:#3a3120; border:1px dashed #5a4a36; border-radius:8px; padding:0.75rem; margin:0; }
        .share-add-row { display:flex; flex-wrap:wrap; gap:0.5rem; align-items:flex-end; }
        .share-dev { margin-top:0.85rem; }
        .share-dev summary { cursor:pointer; color:#a89878; font-size:0.85rem; }
        .share-dev summary:hover { color:#fdf6e8; }
        @media (max-width: 768px) {
          .share-person-perms { gap:0.4rem; }
          .share-add-row { flex-direction:column; align-items:stretch; }
          .share-add-row .btn { width:100%; }
        }
      </style>
      <script nonce="${cspNonce()}">
        (function(){
          // Inline facet selects auto-submit on change (no Set button needed).
          document.querySelectorAll('.js-facet-form .js-facet-select').forEach(function(sel){
            sel.addEventListener('change', function(){ sel.form.submit(); });
          });
          // Add form: group identifier hint placeholder (cosmetic only).
          var addSubject = document.querySelector('.share-add .js-add-subject');
          var addId = document.querySelector('.share-add .js-add-id');
          if (addSubject && addId){
            addSubject.addEventListener('change', function(){
              addId.placeholder = addSubject.value === 'group'
                ? 'platform-team' : 'alice@example.com';
            });
          }
        })();
      </script>
    </div>
  `;

  // ── Database card: per-project Postgres. Either a single "add" button
  // (when disabled) or an "enabled" pill + remove form (with an optional
  // "also delete the data" checkbox). Either way the heavy lifting lands as
  // a commit to the user's repo and ArgoCD syncs it; the card is just a
  // toggle.
  const dbCard = project.giteaRepo ? (project.postgresEnabled ? `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">Database</h3>
      <p class="help" style="margin-bottom:0.85rem;">
        <span class="badge badge-access" style="background:#3a5a36;color:#dff5d0;">Postgres enabled</span>
      </p>
      <p class="help" style="margin-bottom:0.85rem;">Your <code>database</code> container already reads <code>DATABASE_URL</code> from the in-cluster Secret <code>postgres</code> (same namespace) via <code>secretKeyRef</code>. If you hand-write your own Deployment, project <code>DATABASE_URL</code> from the <code>postgres</code> Secret.</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/postgres/disable"
            data-confirm="Remove Postgres from ${escapeHtml(project.slug)}? The database pod is removed by ArgoCD; the data volume stays unless you check &quot;also delete the data&quot; below.">
        ${csrf}
        <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;font-size:0.85rem;color:#a89878;">
          <input type="checkbox" name="destroy_data" value="true" />
          Also delete the data volume (irreversible — drops the PVC and forgets the password).
        </label>
        <button type="submit" class="btn btn-danger btn-sm">Remove Postgres</button>
      </form>
    </div>
  ` : `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">Database</h3>
      <p class="help" style="margin-bottom:0.85rem;">Add a per-project Postgres instance. The platform commits the manifest + sealed credentials to your repo and ArgoCD deploys a one-replica postgres pod in the <code>${escapeHtml(project.slug)}</code> namespace, reachable from your app at <code>postgres:5432</code>.</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/postgres/enable">
        ${csrf}
        <button type="submit" class="btn btn-primary btn-sm">Add Postgres database</button>
      </form>
    </div>
  `) : '';

  // ── Storage card: per-project Garage (S3-compatible object store). Same
  // toggle shape as the Database card — a commit to the user's repo that
  // ArgoCD syncs; the self-bootstrapping image creates the bucket + key.
  const storageCard = project.giteaRepo ? (project.storageEnabled ? `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">File storage</h3>
      <p class="help" style="margin-bottom:0.85rem;">
        <span class="badge badge-access" style="background:#3a5a36;color:#dff5d0;">Garage enabled</span>
      </p>
      <p class="help" style="margin-bottom:0.85rem;">Your <code>storage</code> container reads its S3 connection (<code>S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY_ID</code>, …) from the in-cluster Secret <code>garage</code> (same namespace). If you hand-write your own Deployment, project those keys from the <code>garage</code> Secret — any S3 client works.</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/storage/disable"
            data-confirm="Remove file storage from ${escapeHtml(project.slug)}? The Garage pod is removed by ArgoCD; the data volume stays unless you check &quot;also delete the data&quot; below.">
        ${csrf}
        <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;font-size:0.85rem;color:#a89878;">
          <input type="checkbox" name="destroy_data" value="true" />
          Also delete the data volume (irreversible — drops the PVC and all stored files).
        </label>
        <button type="submit" class="btn btn-danger btn-sm">Remove file storage</button>
      </form>
    </div>
  ` : `
    <div class="app-card" style="margin-top:1.25rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">File storage</h3>
      <p class="help" style="margin-bottom:0.85rem;">Add a per-project S3-compatible object store. The platform commits the manifest + sealed credentials to your repo and ArgoCD deploys a one-replica Garage pod in the <code>${escapeHtml(project.slug)}</code> namespace, reachable from your app at <code>garage:3900</code> (bucket <code>app</code>).</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/storage/enable">
        ${csrf}
        <button type="submit" class="btn btn-primary btn-sm">Add file storage</button>
      </form>
    </div>
  `) : '';

  // ── Danger zone: deliberately small, last, and styled to feel separate
  // from the rest. A hover-confirm prompt still gates the destructive POST.
  const dangerCard = `
    <div class="app-card" style="margin-top:1.25rem;border-color:#7f3d1d;">
      <h3 style="margin:0 0 0.35rem 0;color:#f3a5a5;">Danger zone</h3>
      <p class="help" style="margin-bottom:0.75rem;">
        Deleting <strong>tears down everything</strong>: the Gitea repository, the
        ArgoCD deployment, and the entire <code>${escapeHtml(project.slug)}</code>
        cluster namespace — including any database, file storage, and their data
        volumes. This is permanent and <strong>cannot be undone.</strong>
      </p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/delete"
            class="cv-delete-form"
            data-confirm="Delete project ${escapeHtml(project.slug)}? This permanently removes the repo, deployment, and namespace (data included) and cannot be undone.">
        ${csrf}
        <div class="field" style="max-width:22rem;">
          <label for="cv-delete-confirm">Type <code>${escapeHtml(project.slug)}</code> to confirm</label>
          <input type="text" id="cv-delete-confirm" class="cv-delete-confirm"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                 aria-describedby="cv-delete-hint" placeholder="${escapeHtml(project.slug)}">
        </div>
        <button type="submit" class="btn btn-danger cv-delete-btn">Delete project</button>
      </form>
      <style>
        .cv-delete-form input.cv-delete-confirm { width:100%; }
      </style>
      <script nonce="${cspNonce()}">
        (function(){
          var form = document.currentScript.closest('.app-card').querySelector('.cv-delete-form');
          if (!form) return;
          var input = form.querySelector('.cv-delete-confirm');
          var btn = form.querySelector('.cv-delete-btn');
          var slug = ${JSON.stringify(project.slug)};
          if (!input || !btn) return;
          // JS-enabled: gate the button on an exact slug match. (No-JS callers
          // keep the enabled button + the data-confirm dialog as a fallback.)
          function sync(){ btn.disabled = input.value.trim() !== slug; }
          input.addEventListener('input', sync);
          sync();
        })();
      </script>
    </div>
  `;

  const body = `
    <p style="margin-bottom:1rem;"><a href="/" class="btn btn-secondary btn-sm">← All projects</a></p>
    ${overviewCard}
    ${getStartedCard}
    ${configureCard}
    ${dbCard}
    ${storageCard}
    ${dangerCard}
  `;
  return dashboardLayout(`Project: ${project.name}`, body, email, isAdmin, 'projects');
}

// ── Groups ─────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  name: string;
  owner_id: string;
  member_count: number;
  created_at: string;
}

export interface GroupMemberRow {
  user_id: string;
  username: string | null;
  email: string | null;
}

export function renderGroups(
  email: string,
  isAdmin: boolean,
  viewerId: string,
  groups: GroupRow[],
  csrf: string = '',
  errorMessage: string = ''
): string {
  const errorBanner = errorMessage
    ? `<div class="message error" style="margin-bottom:1rem;">${escapeHtml(errorMessage)}</div>`
    : '';
  const list = groups.length === 0
    ? '<div class="message info">No groups yet. Create the first one below.</div>'
    : `<div class="table-wrap"><table class="table">
        <thead><tr><th>Group</th><th>Members</th><th>Yours?</th></tr></thead>
        <tbody>
        ${groups.map((g) => `
          <tr>
            <td><a href="/groups/${escapeHtml(g.id)}">${escapeHtml(g.name)}</a></td>
            <td>${g.member_count}</td>
            <td>${g.owner_id === viewerId ? '<span class="badge badge-USER">owner</span>' : ''}</td>
          </tr>
        `).join('')}
        </tbody></table></div>`;

  const body = `
    <p class="tagline">Groups bundle members so project owners can grant access to many people at once.</p>
    ${errorBanner}
    ${list}
    <div class="app-card" style="margin-top:1.5rem;">
      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;">Create a group</h3>
      <p class="help" style="margin-bottom:0.75rem;">You own groups you create: you manage their members, and any project owner can grant them access. Groups are visible to every member.</p>
      <form method="POST" action="/groups" style="max-width:420px;">
        ${csrf}
        <div class="field">
          <label for="group_name">Group name</label>
          <input type="text" name="name" id="group_name" required
                 pattern="[a-z0-9][a-z0-9._-]*" maxlength="64"
                 title="lowercase letters, digits, dots, dashes, underscores"
                 placeholder="platform-team">
        </div>
        <button type="submit" class="btn btn-primary">Create group</button>
      </form>
    </div>
  `;
  return dashboardLayout('Groups', body, email, isAdmin, 'groups');
}

export function renderGroupDetail(
  email: string,
  isAdmin: boolean,
  group: { id: string; name: string; owner_id: string },
  members: GroupMemberRow[],
  manageable: boolean,
  csrf: string = ''
): string {
  const memberRows = members.length === 0
    ? '<div class="message info">No members yet.</div>'
    : `<div class="table-wrap"><table class="table">
        <thead><tr><th>Member</th><th>Username</th>${manageable ? '<th></th>' : ''}</tr></thead>
        <tbody>
        ${members.map((m) => `
          <tr>
            <td>${escapeHtml(m.email || m.user_id)}</td>
            <td>${m.username ? `<code>${escapeHtml(m.username)}</code>` : '—'}</td>
            ${manageable ? `
              <td>
                <form method="POST" action="/groups/${escapeHtml(group.id)}/members/${escapeHtml(m.user_id)}/remove" class="inline-form">
                  ${csrf}
                  <button type="submit" class="btn btn-danger btn-sm">Remove</button>
                </form>
              </td>` : ''}
          </tr>
        `).join('')}
        </tbody></table></div>`;

  const manageForms = manageable ? `
    <form method="POST" action="/groups/${escapeHtml(group.id)}/members" style="margin-top:0.85rem;">
      ${csrf}
      <div class="form-row">
        <div class="field">
          <label for="member_identifier">Add member (email or username)</label>
          <input type="text" name="identifier" id="member_identifier" required placeholder="alice@example.com">
        </div>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
    </form>
    <div class="app-card" style="margin-top:1.25rem;border-color:#7f3d1d;">
      <h3 style="margin:0 0 0.35rem 0;color:#f3a5a5;">Danger zone</h3>
      <p class="help" style="margin-bottom:0.75rem;">Deleting the group also revokes every project grant that points at it.</p>
      <form method="POST" action="/groups/${escapeHtml(group.id)}/delete"
            data-confirm="Delete group ${escapeHtml(group.name)}? Project grants to this group are revoked.">
        ${csrf}
        <button type="submit" class="btn btn-danger">Delete group</button>
      </form>
    </div>
  ` : '<p class="help" style="margin-top:0.85rem;">Only the group owner or a platform admin can manage members.</p>';

  const body = `
    <p style="margin-bottom:1rem;"><a href="/groups" class="btn btn-secondary btn-sm">← All groups</a></p>
    <div class="app-card">
      <h2 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1.4rem;"><code>${escapeHtml(group.name)}</code></h2>
      <p class="help" style="margin-bottom:0.75rem;">Project owners grant this group access from their project page (Access → Grants).</p>
      ${memberRows}
      ${manageForms}
    </div>
  `;
  return dashboardLayout(`Group: ${group.name}`, body, email, isAdmin, 'groups');
}

// ── API Keys ───────────────────────────────────────────────

export interface ApiKeyRow {
  clientId: string;
  createdAt: string;
}

// MCP server URL the editor configs point at. PUBLIC_MCP_URL is the
// resource identifier the RFC 9728 well-known announces (host only); the
// streamable-HTTP JSON-RPC endpoint is at <resource>/mcp.
const MCP_URL = MCP_ENDPOINT_URL;
// Host strings for the editor-setup help prose, derived from this deployment's
// own public URLs (single source: services/platform-config) — never hardcoded.
const hostOf = (url: string, fallback: string) => { try { return new URL(url).host; } catch { return fallback; } };
const MCP_HOST = hostOf(MCP_ENDPOINT_URL, `mcp.${BASE_DOMAIN}`);
const OAUTH_HOST = hostOf(OAUTH_PUBLIC_URL, `oauth.${BASE_DOMAIN}`);
const PORTAL_HOST = hostOf(PORTAL_PUBLIC_URL, `portal.${BASE_DOMAIN}`);

// Editor-specific config snippets. Each editor handles OAuth 2.1 + PKCE
// automatically once it sees the 401 + WWW-Authenticate from the MCP
// server — the user never pastes a token. The well-known resource
// metadata at MCP_URL/.well-known/oauth-protected-resource points the
// editor at oauth.corpo-valley.com.
function editorConfigSnippets(): string {
  const claudeAdd = `claude mcp add --transport http corpo-valley ${MCP_URL}`;
  const claudeJson = `{
  "mcpServers": {
    "corpo-valley": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;
  const cursorJson = `{
  "mcpServers": {
    "corpo-valley": {
      "url": "${MCP_URL}"
    }
  }
}`;
  const codexToml = `[mcp_servers.corpo-valley]
url = "${MCP_URL}"`;

  const block = (id: string, label: string, body: string) => `
    <div class="editor-block">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
        <strong style="color:#fdf6e8;">${escapeHtml(label)}</strong>
        <button type="button" class="btn btn-sm btn-secondary cv-copy" data-target="${id}">Copy</button>
      </div>
      <pre class="snippet" id="${id}">${escapeHtml(body)}</pre>
    </div>
  `;

  return `
    ${block('cv-claude-cli', 'Claude Code — one-line CLI', claudeAdd)}
    ${block('cv-claude-json', 'Claude Code — ~/.claude.json (manual)', claudeJson)}
    ${block('cv-cursor-json', 'Cursor — ~/.cursor/mcp.json or Settings → MCP', cursorJson)}
    ${block('cv-codex-toml', 'Codex CLI — ~/.codex/config.toml', codexToml)}

    <style>
      .editor-block { margin-bottom: 1rem; }
      .editor-block .snippet { margin-top: 0; }
    </style>
    <script nonce="${cspNonce()}">
      (function(){
        document.querySelectorAll('.cv-copy').forEach(function(b){
          b.addEventListener('click', function(){
            var el = document.getElementById(b.getAttribute('data-target'));
            if (!el) return;
            navigator.clipboard.writeText(el.innerText).then(function(){
              var prev = b.textContent;
              b.textContent = 'Copied ✓';
              setTimeout(function(){ b.textContent = prev; }, 1500);
            });
          });
        });
      })();
    </script>
  `;
}

export function renderKeyManagement(
  keys: ApiKeyRow[],
  email: string,
  isAdmin: boolean,
  tokenEndpoint: string,
  csrf: string = ''
): string {
  // ── Headline: hook your editor up to Corpo Valley.
  let body = `
    <div class="app-card">
      <h2 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1.4rem;">Connect Claude Code</h2>
      <p class="help" style="margin-bottom:1rem;">
        Point your editor at the Corpo Valley MCP server and it can list, create, and deploy your projects, mint Gitea credentials, and read the platform's own docs. Sign-in happens once via OAuth in your browser — no keys to paste.
      </p>

      <h3 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1rem;">1. Add the server in your editor</h3>
      <p class="help" style="margin-bottom:0.6rem;">Pick the snippet that matches your editor and paste it in. On first use, your editor opens a browser to sign in — you'll see Corpo Valley's normal login flow.</p>
      ${editorConfigSnippets()}

      <h3 style="margin:1.25rem 0 0.35rem 0;color:#fdf6e8;font-size:1rem;">2. Try a first prompt</h3>
      <p class="help" style="margin:0;">Ask the agent: <em>"Use Corpo Valley to list my projects and tell me what each one is."</em>. It'll call the <code>how_corpo_valley_works</code> and <code>list_projects</code> tools, then explain itself.</p>

      <p style="margin-top:1.25rem;font-size:0.85rem;color:#a89878;">
        Full setup guide: <a href="/docs/mcp" style="color:#e8b94a;">${escapeHtml(PORTAL_HOST)}/docs/mcp ↗</a>
      </p>
    </div>

    <details style="margin-top:1.25rem;">
      <summary style="cursor:pointer;color:#a89878;font-size:0.9rem;">Developer details — programmatic API keys</summary>
      <div class="app-card" style="margin-top:0.75rem;">
        <p class="help" style="margin-bottom:0.75rem;">For scripts or CI that can't run OAuth interactively, mint a <code>client_credentials</code> OAuth2 key here and exchange it for a short-lived token at the token endpoint below. These keys grant the same scope as your editor session.</p>
        <form method="POST" action="/keys" style="margin-bottom:1rem;">
          ${csrf}
          <button type="submit" class="btn btn-primary">Create new API key</button>
        </form>`;

  if (keys.length === 0) {
    body += '<div class="message info">No API keys yet.</div>';
  } else {
    body += `<div class="table-wrap"><table class="table">
      <thead><tr><th>Client ID</th><th>Created</th><th></th></tr></thead>
      <tbody>`;
    for (const key of keys) {
      body += `<tr>
        <td><code>${escapeHtml(key.clientId)}</code></td>
        <td>${escapeHtml(key.createdAt)}</td>
        <td>
          <form method="POST" action="/keys/${escapeHtml(key.clientId)}/revoke" class="inline-form"
                data-confirm="Revoke this key? Tokens issued from it will stop working.">
            ${csrf}
            <button type="submit" class="btn btn-danger btn-sm">Revoke</button>
          </form>
        </td>
      </tr>`;
    }
    body += '</tbody></table></div>';
  }

  body += `
        <h4 style="margin-top:1rem;color:#fdf6e8;font-size:0.95rem;">Token endpoint</h4>
        <div class="snippet">${escapeHtml(tokenEndpoint)}/oauth2/token</div>
      </div>
    </details>
  `;

  return dashboardLayout('Connect Claude Code', body, email, isAdmin, 'connect');
}

export function renderNewKeyDisplay(
  clientId: string,
  clientSecret: string,
  email: string,
  isAdmin: boolean,
  tokenEndpoint: string
): string {
  const body = `
    <div class="message success">API key created.</div>
    <p class="key-warning">Save these credentials now. The secret will not be shown again.</p>
    <div class="key-display">
      <strong>Client ID:</strong><br>${escapeHtml(clientId)}<br><br>
      <strong>Client Secret:</strong><br>${escapeHtml(clientSecret)}
    </div>
    <h3 style="margin-top:1.5rem;font-size:1rem;color:#fdf6e8;">Exchange for a token</h3>
    <div class="snippet">curl -X POST ${escapeHtml(tokenEndpoint)}/oauth2/token \\
  -d grant_type=client_credentials \\
  -d client_id=${escapeHtml(clientId)} \\
  -d client_secret=${escapeHtml(clientSecret)}</div>
    <p class="help" style="margin-top:0.75rem;">Use this only for scripts / CI. For your editor, prefer the OAuth flow on the Connect page.</p>
    <p style="margin-top:1rem;"><a href="/connect" class="btn btn-secondary">Back to Connect Claude Code</a></p>
  `;
  return dashboardLayout('New API Key', body, email, isAdmin, 'connect');
}

// Public docs page surfaced from `https://portal.corpo-valley.com/docs/mcp`
// and pointed at from the MCP server's RFC 9728 metadata. Renders without
// the dashboard chrome so unauthenticated visitors (and MCP clients
// fetching it for context) get a clean read.
export function renderMcpDocs(): string {
  const body = `
    <div style="max-width:720px;margin:0 auto;padding:2.5rem 1.5rem;">
      <div class="brand" style="margin-bottom:1.5rem;">
        <div class="brand-name">🌱 Corpo Valley</div>
        <div class="brand-sub">MCP setup for Claude Code, Cursor, and Codex</div>
      </div>

      <h1 style="font-size:1.4rem;color:#fdf6e8;text-align:left;">Connect your editor</h1>
      <p class="help">Corpo Valley speaks the <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener" style="color:#e8b94a;">Model Context Protocol</a>. Once your editor knows about <code>${escapeHtml(MCP_HOST)}</code> it can list and create your projects, mint Gitea credentials for cloning, seal secrets, and read its own documentation — all from the same chat where you're building.</p>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Sign in once, then nothing to paste</h2>
      <p class="help">The server uses OAuth 2.1 with PKCE. The first time your editor connects, it pops a browser to <code>${escapeHtml(OAUTH_HOST)}</code>, you sign in with your normal Corpo Valley account, and tokens land back in the editor. Refreshes happen silently afterwards.</p>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Claude Code</h2>
      <p class="help">From a terminal:</p>
      <div class="snippet">claude mcp add --transport http corpo-valley ${MCP_URL}</div>
      <p class="help" style="margin-top:0.5rem;">Or, in <code>~/.claude.json</code>:</p>
      <div class="snippet">{
  "mcpServers": {
    "corpo-valley": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}</div>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Cursor</h2>
      <p class="help">Settings → MCP → Add new server, or drop this into <code>~/.cursor/mcp.json</code>:</p>
      <div class="snippet">{
  "mcpServers": {
    "corpo-valley": {
      "url": "${MCP_URL}"
    }
  }
}</div>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Codex CLI</h2>
      <p class="help">Add to <code>~/.codex/config.toml</code>:</p>
      <div class="snippet">[mcp_servers.corpo-valley]
url = "${MCP_URL}"</div>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">What the agent can do</h2>
      <ul style="margin:0 0 0 1.5rem;color:#c4b698;font-size:0.9rem;line-height:1.6;">
        <li><code>list_projects</code> / <code>get_project</code> — see what you have.</li>
        <li><code>create_project</code> — plant a new one (provisions repo + CI + deploy).</li>
        <li><code>get_gitea_credentials</code> — hands the agent a ready-to-use clone URL with a short-lived PAT baked in.</li>
        <li><code>set_project_secret</code> — seal a <code>KEY=VALUE</code> map straight into a project namespace.</li>
        <li><code>how_corpo_valley_works</code> — markdown docs the agent can self-serve for context.</li>
      </ul>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">First prompts to try</h2>
      <p class="help">After connecting, try any of these:</p>
      <ul style="margin:0 0 0 1.5rem;color:#c4b698;font-size:0.9rem;line-height:1.6;">
        <li>"Use Corpo Valley. List my projects and tell me what each one does."</li>
        <li>"Make me a new Corpo Valley project called Farm Stand and clone it into <code>~/code</code>."</li>
        <li>"Add an <code>OPENAI_API_KEY</code> secret to my Farm Stand project, then write a Node app that reads it."</li>
      </ul>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Troubleshooting</h2>
      <p class="help"><strong>"401 invalid_token"</strong> usually means the access token expired. Your editor should refresh automatically; if it doesn't, sign out of the MCP server in the editor and let it re-auth.</p>
      <p class="help"><strong>The browser opens to a blank page</strong> after sign-in. That's the loopback redirect — your editor is listening on a random localhost port and the empty page is normal. Switch back to your editor; tokens are already in.</p>

      <p style="margin-top:2rem;"><a href="/" style="color:#e8b94a;">← Back to the portal</a></p>
    </div>
  `;
  return layout('Connect Claude Code, Cursor, Codex', body);
}

// One-shot reveal of a freshly-minted Gitea CLI token, with a pre-baked
// `git clone` command the user can copy directly. Modelled on
// `renderNewKeyDisplay` — same "save this now" affordance.
export function renderGiteaCliTokenReveal(
  email: string,
  isAdmin: boolean,
  project: ProjectRow,
  username: string,
  token: string,
  tokenName: string
): string {
  const cloneUrl = project.giteaRepo
    ? `${GITEA_PUBLIC_URL.replace('://', `://${encodeURIComponent(username)}:${encodeURIComponent(token)}@`)}/${project.giteaRepo}.git`
    : '';
  const cmdBlock = cloneUrl
    ? `git clone ${cloneUrl}
cd ${project.slug}
claude`
    : '';

  const body = `
    <div class="message success">Gitea CLI token <code>${escapeHtml(tokenName)}</code> created.</div>
    <p class="key-warning">Save this now. The token will not be shown again — if you lose it, mint another from your project page.</p>

    <h3 style="margin-top:1.25rem;margin-bottom:0.35rem;">Token</h3>
    <div class="key-display">${escapeHtml(token)}</div>

    ${cmdBlock ? `
      <h3 style="margin-top:1.25rem;margin-bottom:0.35rem;">Ready-to-paste commands</h3>
      <pre class="snippet" id="cv-clone-cmd-revealed">${escapeHtml(cmdBlock)}</pre>
      <button type="button" class="btn btn-sm btn-secondary"
              data-copy-target="cv-clone-cmd-revealed"
              style="margin-top:0.5rem;">Copy commands</button>
      <p class="help" style="margin-top:0.75rem;">The token is embedded in the clone URL — git stores it in <code>.git/config</code> on first use. Pull this off any machine you trust.</p>
    ` : ''}

    <p style="margin-top:1.5rem;"><a href="/projects/${escapeHtml(project.id)}" class="btn btn-secondary">Done — back to project</a></p>
  `;
  return dashboardLayout(`CLI Token: ${project.name}`, body, email, isAdmin, 'projects');
}

// ── Admin Templates ────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  preferredUsername: string;
  firstName: string;
  lastName: string;
  name: string;
  state: string;
  isAdmin: boolean;
}

export function renderAdminUsers(
  users: UserRow[],
  page: number,
  hasMore: boolean,
  email: string
): string {
  let body = `<p style="margin-bottom:1rem;"><a href="/admin/users/new" class="btn btn-primary">Create User</a></p>`;

  body += `<div class="table-wrap"><table class="table">
    <thead><tr><th>Email</th><th>Username</th><th>Name</th><th>State</th><th>Role</th><th></th></tr></thead>
    <tbody>`;
  for (const u of users) {
    body += `<tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${u.preferredUsername ? `<code>${escapeHtml(u.preferredUsername)}</code>` : '<span style="color:#8a7a5a">—</span>'}</td>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.state)}</td>
      <td>${roleBadge(u.isAdmin)}</td>
      <td><a href="/admin/users/${escapeHtml(u.id)}" class="btn btn-secondary btn-sm">Edit</a></td>
    </tr>`;
  }
  body += '</tbody></table></div>';

  // Pagination
  body += '<div class="pagination">';
  if (page > 0) {
    body += `<a href="/admin/users?page=${page - 1}">Previous</a>`;
  }
  body += `<span class="current">Page ${page + 1}</span>`;
  if (hasMore) {
    body += `<a href="/admin/users?page=${page + 1}">Next</a>`;
  }
  body += '</div>';

  return dashboardLayout('Users', body, email, true, 'users');
}

export function renderAdminUserDetail(
  user: UserRow,
  email: string,
  csrf: string = '',
  isSelf: boolean = false,
): string {
  // Danger zone — irreversible delete. Hidden for the acting admin's own row
  // (the route refuses a self-delete anyway).
  const dangerZone = isSelf ? '' : `
    <h3 style="margin-top:1.5rem;color:var(--danger,#c0392b);">Danger Zone</h3>
    <p class="help">Permanently delete this user and everything attached to them — owned projects
      (and their repos, namespaces, and databases), owned groups, group memberships, access grants,
      API keys, the admin role, and the paired bot account. This cannot be undone.</p>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}/delete"
          data-confirm="Permanently delete ${escapeHtml(user.email)} and ALL their projects, repos, and data? This cannot be undone.">
      ${csrf}
      <button type="submit" class="btn btn-danger">Delete user</button>
    </form>
  `;
  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/users" class="btn btn-secondary btn-sm">Back to Users</a></p>
    <table class="table">
      <tr><th>State</th><td>${escapeHtml(user.state)}</td></tr>
      <tr><th>ID</th><td><code>${escapeHtml(user.id)}</code></td></tr>
      <tr><th>Role</th><td>${roleBadge(user.isAdmin)}</td></tr>
    </table>

    <h3 style="margin-top:1.5rem;">Profile</h3>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}">
      ${csrf}
      <div class="field">
        <label>Email</label>
        <input type="email" name="email" value="${escapeHtml(user.email)}" required>
      </div>
      <div class="field">
        <label>Username</label>
        <input type="text" name="preferred_username" value="${escapeHtml(user.preferredUsername)}"
               pattern="[a-zA-Z0-9._-]{1,64}" placeholder="(optional)"
               title="Letters, digits, dot, underscore, hyphen. 1–64 characters.">
      </div>
      <div class="form-row">
        <div class="field">
          <label>First Name</label>
          <input type="text" name="first_name" value="${escapeHtml(user.firstName)}">
        </div>
        <div class="field">
          <label>Last Name</label>
          <input type="text" name="last_name" value="${escapeHtml(user.lastName)}">
        </div>
      </div>
      <button type="submit" class="btn btn-primary">Save Profile</button>
    </form>

    <h3 style="margin-top:1.5rem;">Role</h3>
    <p class="help">Admins can manage users, services, and the project template. Everyone else is a regular user.</p>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}/role"
          ${user.isAdmin ? `data-confirm="Remove the admin role from ${escapeHtml(user.email)}?"` : ''}>
      ${csrf}
      <input type="hidden" name="role" value="${user.isAdmin ? 'user' : 'admin'}">
      <button type="submit" class="btn ${user.isAdmin ? 'btn-danger' : 'btn-primary'}">
        ${user.isAdmin ? 'Remove admin role' : 'Make admin'}
      </button>
    </form>

    <h3 style="margin-top:1.5rem;">Password</h3>
    <p class="help">Issue a one-time recovery code the user can paste into the password-reset flow.</p>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}/recovery">
      ${csrf}
      <button type="submit" class="btn btn-secondary">Generate Recovery Code</button>
    </form>
    ${dangerZone}
  `;
  return dashboardLayout(`User: ${user.email}`, body, email, true, 'users');
}

export function renderAdminUserCreate(
  email: string,
  csrf: string = '',
  errorMessage: string = '',
  prefill: { email?: string; preferred_username?: string; first_name?: string; last_name?: string } = {}
): string {
  const errorBanner = errorMessage
    ? `<div class="message error" style="margin-bottom:1rem;">${escapeHtml(errorMessage)}</div>`
    : '';

  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/users" class="btn btn-secondary btn-sm">Back to Users</a></p>
    ${errorBanner}
    <form method="POST" action="/admin/users">
      ${csrf}
      <div class="field">
        <label>Email (required)</label>
        <input type="email" name="email" value="${escapeHtml(prefill.email || '')}" required>
      </div>
      <div class="field">
        <label>Username</label>
        <input type="text" name="preferred_username" value="${escapeHtml(prefill.preferred_username || '')}"
               pattern="[a-zA-Z0-9._-]{1,64}" placeholder="(optional)"
               title="Letters, digits, dot, underscore, hyphen. 1–64 characters.">
      </div>
      <div class="form-row">
        <div class="field">
          <label>First Name</label>
          <input type="text" name="first_name" value="${escapeHtml(prefill.first_name || '')}">
        </div>
        <div class="field">
          <label>Last Name</label>
          <input type="text" name="last_name" value="${escapeHtml(prefill.last_name || '')}">
        </div>
      </div>
      <p class="help">No password is set on creation. Use the Generate Recovery Code button on the user's profile to issue an initial password-set link.</p>
      <button type="submit" class="btn btn-primary">Create User</button>
    </form>
  `;
  return dashboardLayout('Create User', body, email, true, 'users');
}

export function renderAdminRecoveryResult(
  user: UserRow,
  recoveryLink: string,
  recoveryCode: string,
  expiresAt: string,
  email: string
): string {
  const expiresLine = expiresAt
    ? `<p class="help" style="margin-top:0.5rem;">Expires at <code>${escapeHtml(expiresAt)}</code>. Single-use.</p>`
    : '<p class="help" style="margin-top:0.5rem;">Single-use.</p>';

  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/users/${escapeHtml(user.id)}" class="btn btn-secondary btn-sm">Back to User</a></p>

    <div class="message info" style="margin-bottom:1.5rem;">
      One-time recovery code generated for <strong>${escapeHtml(user.email)}</strong>. Hand the user either the URL or the code below.
    </div>

    <label style="display:block;font-size:0.8rem;color:#c4b698;margin-bottom:0.35rem;font-weight:500;">Recovery URL</label>
    <div class="key-display">${escapeHtml(recoveryLink)}</div>

    <label style="display:block;font-size:0.8rem;color:#c4b698;margin-bottom:0.35rem;font-weight:500;margin-top:1rem;">Recovery Code</label>
    <div class="key-display">${escapeHtml(recoveryCode)}</div>

    ${expiresLine}
  `;
  return dashboardLayout('Recovery Code', body, email, true, 'users');
}

export interface AppRow {
  clientId: string;
  clientName: string;
  adminOnly: boolean;
}

export function renderAdminApps(
  apps: AppRow[],
  email: string,
  csrf: string = ''
): string {
  let body = `<p style="margin-bottom:1rem;"><a href="/admin/apps/register" class="btn btn-primary">Register New Service</a></p>`;

  body += `<div class="table-wrap"><table class="table">
    <thead><tr><th>Client ID</th><th>Name</th><th>Access</th><th>Actions</th></tr></thead>
    <tbody>`;
  for (const app of apps) {
    body += `<tr>
      <td><code>${escapeHtml(app.clientId)}</code></td>
      <td>${escapeHtml(app.clientName)}</td>
      <td>
        <form method="POST" action="/admin/apps/${escapeHtml(app.clientId)}/access" class="inline-form">
          ${csrf}
          <select name="access">
            <option value="all"${app.adminOnly ? '' : ' selected'}>All users</option>
            <option value="admin"${app.adminOnly ? ' selected' : ''}>Admins only</option>
          </select>
          <button type="submit" class="btn btn-secondary btn-sm">Set</button>
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/apps/${escapeHtml(app.clientId)}/delete" class="inline-form"
              data-confirm="Delete ${escapeHtml(app.clientId)}?">
          ${csrf}
          <button type="submit" class="btn btn-danger btn-sm">Delete</button>
        </form>
      </td>
    </tr>`;
  }
  body += '</tbody></table></div>';

  return dashboardLayout('Services', body, email, true, 'apps');
}

export interface TemplateStatusView {
  giteaEnabled: boolean;
  baselineOnDisk: boolean;
  repo: string;
  repoExists: boolean;
  isTemplate: boolean;
  fileCount: number;
}

export interface TemplateResetView {
  action: string;
  reason?: string;
  written?: number;
  deleted?: number;
}

// Repo-access overview for the Community Center template (structurally matches
// services/community-center.ts CommunityCenterAccessOverview — kept as a local
// view type to avoid a templates ↔ service import cycle).
export interface CommunityCenterAccessView {
  giteaEnabled: boolean;
  repo: string;
  adminCount: number;
  manual: Array<{ username: string; permission: string }>;
  branchProtection: {
    configured: boolean;
    forcesPr: boolean;
    pushWhitelist: string[];
    statusChecksEnabled: boolean;
  };
  error?: string;
}

export interface AccessActionResultView {
  ok: boolean;
  message: string;
}

export function renderAdminTemplate(
  status: TemplateStatusView,
  result: TemplateResetView | null,
  email: string,
  csrf: string = '',
  access: CommunityCenterAccessView | null = null,
  accessResult: AccessActionResultView | null = null,
): string {
  const yes = '✓';
  const no = '✗';
  let body = '';

  if (result) {
    const summary = result.action === 'reset' || result.action === 'seeded'
      ? `${escapeHtml(result.action)} — ${result.written ?? 0} file(s) written, ${result.deleted ?? 0} deleted`
      : `${escapeHtml(result.action)}${result.reason ? ` — ${escapeHtml(result.reason)}` : ''}`;
    body += `<div style="margin-bottom:1rem; padding:0.75rem 1rem; border:1px solid #4a90d9; border-radius:4px; background:rgba(74,144,217,0.1);">Reset result: ${summary}</div>`;
  }

  body += `<p>New projects are generated from the <code>${escapeHtml(status.repo)}</code>
    repo in Gitea. Platform admins own its contents: edit it in Gitea to change what
    new projects start with. Resetting overwrites it with this portal build's baseline —
    admin additions are <strong>deleted</strong>.</p>`;

  body += `<div class="table-wrap"><table class="table">
    <tbody>
      <tr><th>Gitea integration</th><td>${status.giteaEnabled ? yes : no}</td></tr>
      <tr><th>Baseline in portal image</th><td>${status.baselineOnDisk ? yes : no}</td></tr>
      <tr><th>Template repo exists</th><td>${status.repoExists ? yes : no}</td></tr>
      <tr><th>Marked as template</th><td>${status.isTemplate ? yes : no}</td></tr>
      <tr><th>Files in template</th><td>${status.fileCount}</td></tr>
    </tbody></table></div>`;

  if (status.giteaEnabled && status.baselineOnDisk) {
    body += `
    <form method="POST" action="/admin/template/reset" style="margin-top:1rem;"
          data-confirm="Reset ${escapeHtml(status.repo)} to the baseline? Admin edits and additions will be lost.">
      ${csrf}
      <button type="submit" class="btn btn-danger">Reset template to baseline</button>
    </form>`;
  }

  body += renderCommunityCenterAccessPanel(access, accessResult, csrf);

  return dashboardLayout('Project Template', body, email, true, 'template');
}

// The "Repo access" panel on the Project Template page: who can write to the
// template repo (admins are auto-managed; non-admins added by hand), the
// branch-protection status, and the manual add/remove controls.
function renderCommunityCenterAccessPanel(
  access: CommunityCenterAccessView | null,
  accessResult: AccessActionResultView | null,
  csrf: string,
): string {
  let html = `<div class="app-card" style="margin-top:2rem;">
    <h2 style="margin-top:0;">Repo access</h2>
    <p class="help">Who can write to the <code>${escapeHtml(access?.repo || 'community-center')}</code>
      template repo. <strong>Write</strong> means create branches and merge pull requests.
      Direct pushes to <code>main</code> are blocked by branch protection (only the platform
      account may push directly), so everyone else must open a PR. Platform admins are added
      as write collaborators automatically and stay in sync with their role; the list below is
      for granting access to non-admin users by hand.</p>`;

  if (!access || !access.giteaEnabled) {
    html += `<div class="message info" style="margin-top:1rem;">Gitea integration is not configured on this deployment, so repo access cannot be managed here.</div></div>`;
    return html;
  }

  if (accessResult) {
    const cls = accessResult.ok ? 'success' : 'error';
    html += `<div class="message ${cls}" style="margin-top:1rem;">${escapeHtml(accessResult.message)}</div>`;
  }
  if (access.error) {
    html += `<div class="message error" style="margin-top:1rem;">${escapeHtml(access.error)}</div>`;
  }

  // Branch-protection status.
  const bp = access.branchProtection;
  const bpLine = !bp.configured
    ? `<span style="color:#f3a5a5;">Not configured — direct pushes to <code>main</code> are NOT restricted.</span>`
    : bp.forcesPr
      ? `PRs are enforced — only ${bp.pushWhitelist.length
          ? bp.pushWhitelist.map((u) => `<code>${escapeHtml(u)}</code>`).join(', ')
          : '(no one)'} may push directly to <code>main</code>. `
        + `Merge status checks: ${bp.statusChecksEnabled ? 'on' : 'off'}.`
      : `<span style="color:#f3a5a5;">Branch protection exists but does not restrict direct push.</span>`;
  html += `<p style="margin-top:1rem;"><strong>Branch protection:</strong> ${bpLine}</p>`;
  html += `<p class="help"><strong>${access.adminCount}</strong> platform admin(s) have automatic write access (managed by role, not shown below).</p>`;

  // Manual (non-admin) collaborators.
  html += `<h3 style="margin-top:1.5rem;">Manually-granted users</h3>`;
  if (!access.manual.length) {
    html += `<p class="help">No non-admin users have been granted access by hand.</p>`;
  } else {
    html += `<div class="table-wrap"><table class="table">
      <thead><tr><th>Username</th><th>Permission</th><th></th></tr></thead><tbody>`;
    for (const c of access.manual) {
      html += `<tr>
        <td><code>${escapeHtml(c.username)}</code></td>
        <td>${escapeHtml(c.permission)}</td>
        <td>
          <form method="POST" action="/admin/template/access/revoke" class="inline-form"
                data-confirm="Remove ${escapeHtml(c.username)} from the template repo?">
            ${csrf}
            <input type="hidden" name="username" value="${escapeHtml(c.username)}">
            <button type="submit" class="btn btn-danger btn-sm">Remove</button>
          </form>
        </td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Grant form.
  html += `<h3 style="margin-top:1.5rem;">Grant access</h3>
    <p class="help">Enter a user's email address or username. They must be a non-admin
      human (admins are managed automatically). They'll be added as a <code>write</code> collaborator.</p>
    <form method="POST" action="/admin/template/access/grant">
      ${csrf}
      <div class="field">
        <label>Email or username</label>
        <input type="text" name="identifier" placeholder="user@example.com or username" required>
      </div>
      <button type="submit" class="btn btn-primary">Grant write access</button>
    </form>`;

  html += `</div>`;
  return html;
}

// ── Project Resources (per-project memory budget) ──────────

export interface ResourceFieldView {
  key: string;
  label: string;
  placeholder: string;  // the current platform default
  help: string;
  value: string;        // the admin's raw input, re-rendered on validation error
}

export interface ResourceGroupView {
  title: string;
  fields: ResourceFieldView[];
}

export interface ProjectResourcesResultView {
  ok: boolean;
  slug: string;
  message: string;
  // Per-volume storage outcomes (grown / unsupported / skipped), if a PVC grow
  // was requested.
  details?: string[];
  // Set when a volume could not be expanded online — link the storage help page.
  helpLink?: boolean;
}

export function renderAdminProjectResources(
  groups: ResourceGroupView[],
  result: ProjectResourcesResultView | null,
  email: string,
  csrf: string = '',
  slugValue: string = '',
): string {
  let body = '';

  if (result) {
    const color = result.ok ? '#84a25a' : '#d9734a';
    const bg = result.ok ? 'rgba(132,162,90,0.12)' : 'rgba(217,115,74,0.12)';
    let banner = `${result.ok ? '✓' : '✗'} <strong>${escapeHtml(result.slug)}</strong> — ${escapeHtml(result.message)}`;
    if (result.details && result.details.length) {
      banner += `<ul style="margin:0.5rem 0 0 1rem; padding:0;">`
        + result.details.map((d) => `<li>${escapeHtml(d)}</li>`).join('') + `</ul>`;
    }
    if (result.helpLink) {
      banner += `<div style="margin-top:0.5rem;">A volume's StorageClass can't be expanded online — `
        + `see <a href="/admin/help/storage">how to take advantage of the new size</a>.</div>`;
    }
    body += `<div style="margin-bottom:1rem; padding:0.75rem 1rem; border:1px solid ${color}; border-radius:4px; background:${bg};">${banner}</div>`;
  }

  body += `<p>Raise one project's resource budget — its <code>ResourceQuota</code>
    + <code>LimitRange</code>, and (for storage) the size of its data volumes.
    The platform applies these once at project creation, so a changed platform
    default — or a per-project bump — only reaches an existing project through
    here. Leave a field blank to <strong>keep that field's current value
    unchanged</strong> (the placeholder shows the platform default for
    reference). Overrides are <strong>up-only</strong>: you can grant more than
    the default, not less.</p>`;

  const field = (f: ResourceFieldView) => `
      <div class="field">
        <label>${escapeHtml(f.label)}</label>
        <input type="text" name="${escapeHtml(f.key)}" value="${escapeHtml(f.value)}"
               placeholder="${escapeHtml(f.placeholder)}" autocomplete="off" spellcheck="false">
        <div style="font-size:0.8rem; color:#8a7a5a; margin-top:0.25rem;">${escapeHtml(f.help)}</div>
      </div>`;

  const sections = groups.map((g) => `
      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">${escapeHtml(g.title)}</legend>
        ${g.fields.map(field).join('')}
      </fieldset>`).join('');

  body += `
    <form method="POST" action="/admin/projects/resources" style="max-width:34rem;">
      ${csrf}
      <div class="field">
        <label>Project slug</label>
        <input type="text" name="slug" value="${escapeHtml(slugValue)}" required
               placeholder="my-project" autocomplete="off" spellcheck="false">
      </div>
      ${sections}
      <button type="submit" class="btn">Apply to project</button>
    </form>`;

  return dashboardLayout('Project Resources', body, email, true, 'resources');
}

export interface CooldepsResultView { ok: boolean; message: string; }

// /admin/cooldeps — edit the runtime cooldeps gating policy. `record` is the
// stored config (or built-in defaults when never saved); on save the route
// persists it and reconciles the cv-cooldeps ConfigMap + Deployment.
export function renderAdminCooldeps(
  record: import('./services/cooldeps-config').CooldepsConfigRecord,
  result: CooldepsResultView | null,
  email: string,
  csrf: string = '',
): string {
  const cfg = record.config;
  const p = cfg.policy;
  let body = '';

  if (result) {
    const color = result.ok ? '#84a25a' : '#d9734a';
    const bg = result.ok ? 'rgba(132,162,90,0.12)' : 'rgba(217,115,74,0.12)';
    body += `<div style="margin-bottom:1rem; padding:0.75rem 1rem; border:1px solid ${color}; border-radius:4px; background:${bg};">`
      + `${result.ok ? '✓' : '✗'} ${escapeHtml(result.message)}</div>`;
  }

  const meta = record.persisted && record.updatedAt
    ? `Last saved ${escapeHtml(record.updatedAt)}${record.updatedBy ? ` by ${escapeHtml(record.updatedBy)}` : ''}.`
    : `Showing built-in defaults — not yet customised for this deployment.`;

  body += `<p>Tune the <strong>cooldeps</strong> dependency gate. These apply to
    every npm/PyPI/Go install routed through the proxy (CI runners, and any build
    or machine pointed at it). Saving rewrites the proxy's config and restarts it,
    so changes take effect within a few seconds. <span style="color:#8a7a5a;">${meta}</span></p>`;

  const checkbox = (name: string, label: string, checked: boolean, help: string) => `
      <label style="display:flex; gap:0.5rem; align-items:flex-start; margin:0.4rem 0;">
        <input type="checkbox" name="${name}" value="true"${checked ? ' checked' : ''} style="margin-top:0.2rem;">
        <span>${escapeHtml(label)}<br><span style="font-size:0.8rem; color:#8a7a5a;">${escapeHtml(help)}</span></span>
      </label>`;

  const textarea = (name: string, label: string, items: string[], help: string) => `
      <div class="field">
        <label>${escapeHtml(label)}</label>
        <textarea name="${name}" rows="4" autocomplete="off" spellcheck="false"
          style="width:100%; font-family:monospace;">${escapeHtml(items.join('\n'))}</textarea>
        <div style="font-size:0.8rem; color:#8a7a5a; margin-top:0.25rem;">${escapeHtml(help)}</div>
      </div>`;

  const sevOptions = ['', 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
    .map((s) => `<option value="${s}"${p.cve.maxSeverity === s ? ' selected' : ''}>${s === '' ? '(disabled)' : s}</option>`)
    .join('');
  const logOptions = ['debug', 'info', 'warn', 'error']
    .map((s) => `<option value="${s}"${cfg.logLevel === s ? ' selected' : ''}>${s}</option>`)
    .join('');

  body += `
    <form method="POST" action="/admin/cooldeps" style="max-width:40rem;">
      ${csrf}
      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">Release age (the cooldown)</legend>
        <div class="field">
          <label>Cooldown window (days)</label>
          <input type="number" name="minDays" min="0" max="3650" value="${p.releaseAge.minDays}" style="width:8rem;">
          <div style="font-size:0.8rem; color:#8a7a5a; margin-top:0.25rem;">Hold releases younger than this. 0 disables the cooldown.</div>
        </div>
        ${checkbox('releaseAgeWarnOnly', 'Warn only', p.releaseAge.warnOnly, 'Allow fresh releases but log a warning instead of blocking.')}
        ${checkbox('releaseAgeBlockOnUnknown', 'Block on unknown age', p.releaseAge.blockOnUnknown, "Block versions whose publish date can't be determined.")}
      </fieldset>

      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">Known vulnerabilities (CVE)</legend>
        <div class="field">
          <label>Max allowed severity</label>
          <select name="cveMaxSeverity" style="width:12rem;">${sevOptions}</select>
          <div style="font-size:0.8rem; color:#8a7a5a; margin-top:0.25rem;">Block versions with a CVE at or above this. "(disabled)" turns off CVE checks.</div>
        </div>
        ${checkbox('cveWarnOnly', 'Warn only', p.cve.warnOnly, 'Allow vulnerable versions but log a warning instead of blocking.')}
      </fieldset>

      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">License policy</legend>
        ${textarea('licenseAllow', 'Allowed licenses', p.license.allow, 'One SPDX id per line. Leave empty to allow everything not in the block list.')}
        ${textarea('licenseBlock', 'Blocked licenses', p.license.block, 'One SPDX id per line.')}
        ${checkbox('licenseWarnOnUnknown', 'Warn on unknown license', p.license.warnOnUnknown, 'Warn (not block) when a version has no detectable license.')}
      </fieldset>

      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">Override pins (incident response)</legend>
        ${textarea('overridesAllow', 'Force-allow', p.overrides.allow, 'Let a specific release through the checks. e.g. npm:laps@1.0.1')}
        ${textarea('overridesBlock', 'Force-block', p.overrides.block, 'Kill a known-bad release immediately. e.g. npm:left-pad@1.0.0')}
      </fieldset>

      <fieldset style="border:1px solid #5a4a36; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <legend style="padding:0 0.5rem; color:#c4b698;">Behaviour</legend>
        ${checkbox('failOpen', 'Fail open', p.failOpen, 'If the upstream registries / OSV are unreachable, allow installs (warn) instead of blocking. Off is safer.')}
        <div class="field">
          <label>Log level</label>
          <select name="logLevel" style="width:10rem;">${logOptions}</select>
        </div>
        ${checkbox('statusEnabled', 'Expose /status endpoint', cfg.statusEnabled, 'Serve cooldeps runtime stats at /status. Off by default.')}
      </fieldset>

      <button type="submit" class="btn">Save &amp; apply</button>
    </form>`;

  return dashboardLayout('cooldeps', body, email, true, 'cooldeps');
}

// Help page for the case the storage reconciler can't handle automatically: a
// StorageClass without allowVolumeExpansion. Linked from the resource form when
// a grow attempt comes back `unsupported`.
export function renderStorageHelp(email: string): string {
  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/projects/resources" class="btn btn-secondary btn-sm">Back to Project Resources</a></p>
    <h2>Increasing a project's storage</h2>
    <p>Raising <strong>Max total storage</strong> lifts the namespace
      <code>ResourceQuota</code> ceiling, and raising <strong>Grow data volumes
      to</strong> resizes the project's Postgres/Garage PVCs. Whether a volume can
      grow <em>in place</em> depends on its <code>StorageClass</code>.</p>

    <h3>Check whether the StorageClass supports expansion</h3>
    <pre><code>kubectl get storageclass &lt;name&gt; -o jsonpath='{.allowVolumeExpansion}'</code></pre>
    <p><code>true</code> → the portal grows the volume online when you set a new
      size (it restarts the pod automatically if the filesystem resize needs it).
      <code>false</code> or empty → expansion is not supported, and you must
      migrate the data to a larger volume manually.</p>

    <h3>Manual migration (StorageClass can't expand)</h3>
    <p>The raised <strong>Max total storage</strong> ceiling already applies to
      <em>new</em> volumes, so the goal is to recreate the data volume larger:</p>
    <ol>
      <li><strong>Back up the data.</strong> Postgres: <code>pg_dump</code> the
        database. Garage: copy the bucket contents (e.g. <code>aws s3 sync</code>
        against the in-cluster endpoint).</li>
      <li><strong>Disable the capability</strong> from the project's portal page
        (or the <code>disable_postgres</code> / <code>disable_storage</code> MCP
        tool). This prunes the StatefulSet; on the next enable the
        volumeClaimTemplate is recreated at the current default size.</li>
      <li><strong>Delete the old PVC</strong> so a fresh, larger one is bound:
        <code>kubectl delete pvc data-postgres-0 -n &lt;slug&gt;</code> (or
        <code>data-garage-0</code>).</li>
      <li><strong>Re-enable the capability</strong> and <strong>restore</strong>
        the backup into the new volume.</li>
    </ol>
    <p style="color:#8a7a5a; font-size:0.85rem;">A changed platform default only
      reaches existing projects through the Project Resources form — it is not
      swept across every namespace.</p>`;
  return dashboardLayout('Storage Help', body, email, true, 'resources');
}

export function renderAdminRegisterForm(email: string, csrf: string = ''): string {
  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/apps" class="btn btn-secondary btn-sm">Back to Services</a></p>
    <form method="POST" action="/admin/apps/register">
      ${csrf}
      <div class="field">
        <label>App Name (client ID)</label>
        <input type="text" name="appName" required placeholder="e.g. gitea">
      </div>
      <div class="field">
        <label>Display Name</label>
        <input type="text" name="displayName" required placeholder="e.g. Gitea">
      </div>
      <div class="field">
        <label>Access</label>
        <select name="access">
          <option value="all">All users</option>
          <option value="admin">Admins only</option>
        </select>
      </div>
      <div class="field">
        <label>Redirect URI</label>
        <input type="text" name="redirectUri" required placeholder="https://app.example.com/auth/callback">
      </div>
      <button type="submit" class="btn btn-primary" style="width:auto;">Register</button>
    </form>
  `;
  return dashboardLayout('Register Service', body, email, true, 'apps');
}

export function renderAdminRegisterResult(
  clientId: string,
  clientSecret: string,
  adminOnly: boolean,
  email: string
): string {
  const body = `
    <div class="message success">Service registered successfully.</div>
    <p class="key-warning">Save these credentials now. The secret will not be shown again.</p>
    <div class="key-display">
      <strong>Client ID:</strong><br>${escapeHtml(clientId)}<br><br>
      <strong>Client Secret:</strong><br>${escapeHtml(clientSecret)}<br><br>
      <strong>Access:</strong><br>${adminOnly ? 'Admins only' : 'All users'}
    </div>
    <p style="margin-top:1rem;"><a href="/admin/apps" class="btn btn-secondary">Back to Services</a></p>
  `;
  return dashboardLayout('Service Registered', body, email, true, 'apps');
}

// ── Bespoke auth page renderers ────────────────────────────
// We render /login, /registration, /recovery, /settings explicitly rather
// than walking flow.ui.nodes generically. Each page knows what fields it
// has and how they should look. /verification and /error still use
// renderFlow as a generic fallback because they're rare and not worth a
// custom design.

function getNode(nodes: UiNode[], name: string): UiNode | undefined {
  return nodes.find(n => n.attributes.name === name);
}

interface ExtractedField {
  value: string;
  error?: string;
}

function extractField(node: UiNode | undefined): ExtractedField {
  if (!node) return { value: '' };
  const error = (node.messages || []).find(m => m.type === 'error');
  return {
    value: (node.attributes as any).value || '',
    error: error?.text,
  };
}

function extractCsrf(nodes: UiNode[]): string {
  return extractField(getNode(nodes, 'csrf_token')).value;
}

interface OidcProvider {
  name: string;
  label: string;
}

function extractOidcProviders(nodes: UiNode[]): OidcProvider[] {
  return nodes
    .filter(n => n.group === 'oidc' && n.attributes.type === 'submit')
    .map(n => ({
      name: (n.attributes as any).value || '',
      label: n.meta.label?.text || (n.attributes as any).value || 'Continue',
    }));
}

function fieldErrorHtml(error?: string): string {
  if (!error) return '';
  return `<div class="message error" style="margin-top:0.35rem;">${escapeHtml(error)}</div>`;
}

function topMessagesHtml(messages?: UiMessage[]): string {
  if (!messages || messages.length === 0) return '';
  return `<div class="messages">${messages.map(m => `<div class="message ${escapeHtml(m.type)}">${escapeHtml(m.text)}</div>`).join('')}</div>`;
}

function oidcButtonHtml(provider: OidcProvider): string {
  const icon = provider.name === 'google' ? GOOGLE_SVG : '';
  const display = provider.name.charAt(0).toUpperCase() + provider.name.slice(1);
  return `<button type="submit" name="provider" value="${escapeHtml(provider.name)}" class="social-btn">${icon}Continue with ${escapeHtml(display)}</button>`;
}

function hiddenCsrf(csrf: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`;
}

export function renderLoginPage(
  action: string,
  nodes: UiNode[],
  messages: UiMessage[] | undefined,
  footerHtml: string,
  // Google-only mode (decision D4): show just the OIDC button(s); the
  // password/code forms stay reachable via /login?method=password as the
  // break-glass path. Ignored when the flow carries no OIDC nodes (e.g.
  // Kratos misconfigured) so a broken Google setup can't lock everyone out.
  opts: { googleOnly?: boolean } = {},
): string {
  const csrf = extractCsrf(nodes);
  const oidc = extractOidcProviders(nodes);
  const identifier = extractField(getNode(nodes, 'identifier'));
  const passwordField = extractField(getNode(nodes, 'password'));
  const codeField = extractField(getNode(nodes, 'code'));
  const hasPassword = nodes.some(n => n.group === 'password' && n.attributes.type === 'password');
  const hasCodeSubmit = nodes.some(n => n.group === 'code' && n.attributes.type === 'submit');
  // After "Email me a code" is clicked, Kratos returns the same flow with a
  // `code` text input added — user pastes the code from email and submits.
  const inCodeStage = nodes.some(n => n.group === 'code' && n.attributes.name === 'code' && n.attributes.type !== 'submit');
  // Resend button (Kratos sometimes emits a second submit in the code group
  // for re-issuing the email — value=code with a `resend=true` semantics).
  const resendNode = nodes.find(n => n.group === 'code' && n.attributes.type === 'submit' && (n.attributes as any).name === 'resend');

  let body = `<h1>Sign in</h1>${topMessagesHtml(messages)}`;

  // Stage 2: user has been sent a code and is entering it.
  if (inCodeStage) {
    body += `<form action="${escapeHtml(action)}" method="POST">
      ${hiddenCsrf(csrf)}
      <div class="field">
        <label for="identifier">Email</label>
        <input type="email" name="identifier" id="identifier" value="${escapeHtml(identifier.value)}" required readonly>
        ${fieldErrorHtml(identifier.error)}
      </div>
      <div class="field">
        <label for="code">Login code</label>
        <input type="text" name="code" id="code" value="${escapeHtml(codeField.value)}" required autofocus inputmode="numeric" autocomplete="one-time-code">
        ${fieldErrorHtml(codeField.error)}
      </div>
      <button type="submit" name="method" value="code">Sign in</button>
      ${resendNode ? `
        <button type="submit" name="resend" value="code" formnovalidate style="background:#4a3c2c;color:#f3ead9;margin-top:0.5rem;">Resend code</button>
      ` : ''}
    </form>${footerHtml}`;
    return layout('Sign In', body);
  }

  // Stage 1 (default): show the OIDC button + the email/password form.
  const googleOnly = !!opts.googleOnly && oidc.length > 0;
  if (oidc.length > 0) {
    body += `<form action="${escapeHtml(action)}" method="POST">
      ${hiddenCsrf(csrf)}
      ${oidc.map(oidcButtonHtml).join('')}
    </form>`;
    if (!googleOnly && (hasPassword || hasCodeSubmit)) body += '<div class="divider">or</div>';
  }

  if (!googleOnly && (hasPassword || hasCodeSubmit)) {
    body += `<form action="${escapeHtml(action)}" method="POST">
      ${hiddenCsrf(csrf)}
      <div class="field">
        <label for="identifier">Email</label>
        <input type="email" name="identifier" id="identifier" value="${escapeHtml(identifier.value)}" required autofocus>
        ${fieldErrorHtml(identifier.error)}
      </div>
      ${hasPassword ? `
        <div class="field">
          <label for="password">Password</label>
          <input type="password" name="password" id="password" required>
          ${fieldErrorHtml(passwordField.error)}
        </div>
        <button type="submit" name="method" value="password">Sign in</button>
      ` : ''}
      ${hasCodeSubmit ? `
        <button type="submit" name="method" value="code" formnovalidate${hasPassword ? ' style="background:#4a3c2c;color:#f3ead9;margin-top:0.5rem;"' : ''}>Email me a code</button>
      ` : ''}
    </form>`;
  }

  body += footerHtml;
  return layout('Sign In', body);
}

// renderRegistrationPage removed: self-service registration is disabled.

export function renderRecoveryPage(
  action: string,
  nodes: UiNode[],
  messages: UiMessage[] | undefined,
  footerHtml: string,
): string {
  const csrf = extractCsrf(nodes);
  const email = extractField(getNode(nodes, 'email'));
  const code = extractField(getNode(nodes, 'code'));
  // After Kratos sends the email, the same flow page renders with a `code`
  // text input added. Switch the page's title and submit label accordingly.
  const inCodeStage = nodes.some(n => n.group === 'code' && n.attributes.name === 'code' && n.attributes.type !== 'submit');

  const title = inCodeStage ? 'Enter recovery code' : 'Recover account';
  const submitLabel = inCodeStage ? 'Continue' : 'Send recovery email';

  let body = `<h1>${title}</h1>${topMessagesHtml(messages)}`;
  // In the code stage the email is display-only and MUST NOT be submitted:
  // Kratos's recovery `code` strategy treats a posted `email` field as a
  // request to (re)send a code, so including it makes every code submission
  // resend instead of verify — an endless loop. We drop `name="email"` here
  // so the POST body carries only csrf_token + code + method=code; the flow
  // ID in the form action is all Kratos needs to verify the code.
  body += `<form action="${escapeHtml(action)}" method="POST">
    ${hiddenCsrf(csrf)}
    <div class="field">
      <label for="email">Email</label>
      <input type="email"${inCodeStage ? '' : ' name="email"'} id="email" value="${escapeHtml(email.value)}"${inCodeStage ? ' readonly' : ' required autofocus'}>
      ${fieldErrorHtml(email.error)}
    </div>
    ${inCodeStage ? `
      <div class="field">
        <label for="code">Recovery code</label>
        <input type="text" name="code" id="code" value="${escapeHtml(code.value)}" required autofocus inputmode="numeric" autocomplete="one-time-code">
        ${fieldErrorHtml(code.error)}
      </div>
    ` : ''}
    <button type="submit" name="method" value="code">${submitLabel}</button>
  </form>`;
  body += footerHtml;
  return layout(title, body);
}

export function renderSettingsPage(
  action: string,
  nodes: UiNode[],
  messages: UiMessage[] | undefined,
  footerHtml: string,
): string {
  const csrf = extractCsrf(nodes);
  const passwordField = extractField(getNode(nodes, 'password'));

  const hasPassword = nodes.some(n => n.group === 'password' && n.attributes.type === 'password');

  let body = `<h1>Account settings</h1>${topMessagesHtml(messages)}`;

  // Only the password form is offered. Profile fields (email / username / name)
  // are intentionally NOT rendered — users may not edit their own traits; only
  // an admin can, via /admin/users. The Kratos `profile` settings method is also
  // disabled server-side (selfservice.methods.profile.enabled=false), so this is
  // defense-in-depth, not the sole control.
  if (hasPassword) {
    body += `
      <h3 style="font-size:1rem;color:#fdf6e8;margin-top:1.5rem;margin-bottom:0.75rem;">Password</h3>
      <form action="${escapeHtml(action)}" method="POST">
        ${hiddenCsrf(csrf)}
        <div class="field">
          <label for="password">New password</label>
          <input type="password" name="password" id="password" required autofocus>
          ${fieldErrorHtml(passwordField.error)}
        </div>
        <button type="submit" name="method" value="password">Save password</button>
      </form>
    `;
  }

  body += `<p class="help" style="margin-top:1.5rem;">Need to change your email, username, or name? Contact an administrator.</p>`;
  body += footerHtml;
  return layout('Account Settings', body);
}
