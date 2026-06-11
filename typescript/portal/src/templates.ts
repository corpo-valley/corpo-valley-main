// HTML template rendering helpers for Ory auth flows + Corpo Valley dashboard.
//
// Branding note: Corpo Valley wears a light Stardew-Valley-ish coat — a warm
// earthy palette and a 🌱 sprout in the wordmark — without going full
// pixel-art. The structural CSS approach (clean, responsive, inline) is
// carried over from the reference portal.

import { cspNonce } from './lib/csp-nonce';

const GOOGLE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align:middle;margin-right:8px;"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

const GITHUB_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:6px;"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

const SITE_FOOTER = `
    <footer class="site-footer">
      <a href="https://github.com/corpo-valley/corpo-valley-main" target="_blank" rel="noopener noreferrer">${GITHUB_SVG}corpo-valley on GitHub</a>
    </footer>`;

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
  button[type="submit"], input[type="submit"] {
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
  button[type="submit"]:hover, input[type="submit"]:hover { background: #93b366; }
  button[type="submit"]:active { transform: scale(0.98); }
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
  .btn { display: inline-block; padding: 0.4rem 0.75rem; border-radius: 5px; font-size: 0.85rem; text-decoration: none; border: none; cursor: pointer; font-weight: 500; text-align: center; }
  .btn-primary { background: #84a25a; color: #1f2912; }
  .btn-primary:hover { background: #93b366; }
  .btn-secondary { background: #4a3c2c; color: #f3ead9; }
  .btn-secondary:hover { background: #5a4a36; }
  .btn-danger { background: #7f3d1d; color: #f3a5a5; }
  .btn-danger:hover { background: #6b3217; }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

  /* Tier badges */
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .badge-EVERYONE { background: #4d6624; color: #c3e0a0; }
  .badge-BETA { background: #6b5a2a; color: #e8d39a; }
  .badge-ALPHA { background: #5a4a2a; color: #d8c48a; }
  .badge-ADMIN { background: #7f3d1d; color: #f3a5a5; }
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
    <a href="/login">Back to Login</a>
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
      <a href="/login">Back to Login</a>
    </div>
  </div>`;
  return layout(title, body);
}

// ── Dashboard Templates ────────────────────────────────────

export function tierBadge(tier: string): string {
  return `<span class="badge badge-${escapeHtml(tier)}">${escapeHtml(tier)}</span>`;
}

interface NavItem { label: string; href: string; key: string; }

function dashboardLayout(
  title: string,
  bodyHtml: string,
  email: string,
  isAdmin: boolean,
  activeNav: string
): string {
  const navItems: NavItem[] = [
    { label: 'Projects', href: '/', key: 'projects' },
    { label: 'Connect Claude Code', href: '/connect', key: 'connect' },
  ];
  let adminNav = '';
  if (isAdmin) {
    adminNav = `
      <div class="nav-section">Admin</div>
      <a href="/admin/users"${activeNav === 'users' ? ' class="active"' : ''}>Users</a>
      <a href="/admin/apps"${activeNav === 'apps' ? ' class="active"' : ''}>Services</a>
      <a href="/admin/template"${activeNav === 'template' ? ' class="active"' : ''}>Project Template</a>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Corpo Valley</title>
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
  serviceAccess: string;
  repoAccess: string;
  createdAt: string;
  giteaRepo?: string | null;
  // True when k8s/postgres.yaml exists in the project repo — the Database
  // card uses this to choose the enable vs. remove control.
  postgresEnabled?: boolean;
}

function accessBadge(value: string): string {
  return `<span class="badge badge-access">${escapeHtml(value)}</span>`;
}

export function renderProjects(
  email: string,
  projects: ProjectRow[],
  userTier: string,
  isAdmin: boolean
): string {
  let body = `
    <p class="tagline">Your patch of the valley — every app starts as a project. Your tier: ${tierBadge(userTier)}</p>
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
      const url = `https://${escapeHtml(p.slug)}.projects.corpo-valley.com`;
      body += `
        <div class="app-card">
          <div class="app-card-header">
            <span class="app-card-name">${escapeHtml(p.name)}</span>
          </div>
          <div class="app-card-sub"><a href="${url}" target="_blank" rel="noopener" style="color:#e8b94a;">${escapeHtml(p.slug)}.projects.corpo-valley.com ↗</a></div>
          <div class="app-card-sub" style="margin-top:0.4rem;">Service: ${accessBadge(p.serviceAccess)} &nbsp; Repo: ${accessBadge(p.repoAccess)}</div>
          <div class="app-card-actions">
            <a href="/projects/${escapeHtml(p.id)}" class="btn btn-secondary">Open</a>
            ${p.giteaRepo
              ? `<a href="https://gitea.corpo-valley.com/${escapeHtml(p.giteaRepo)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Repo ↗</a>`
              : ''}
          </div>
        </div>`;
    }
    body += '</div>';
  }

  return dashboardLayout('Projects', body, email, isAdmin, 'projects');
}

const SERVICE_ACCESS_OPTS = ['private', 'shared'];
const REPO_ACCESS_OPTS = ['private-edit', 'shared-edit'];

function selectOptions(opts: string[], selected: string): string {
  return opts.map(o => `<option value="${escapeHtml(o)}"${o === selected ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
}

export function renderProjectCreate(
  email: string,
  isAdmin: boolean,
  csrf: string = '',
  errorMessage: string = '',
  prefill: { slug?: string; name?: string; service_access?: string; repo_access?: string; visibility?: string; database?: boolean; mcp?: boolean } = {}
): string {
  const errorBanner = errorMessage
    ? `<div class="message error" style="margin-bottom:1rem;">${escapeHtml(errorMessage)}</div>`
    : '';

  // Map prefill back to a visibility preset. Anything that doesn't fall
  // into one of the two named presets re-opens the advanced section as Custom.
  const preset = ((): string => {
    const sa = prefill.service_access, ra = prefill.repo_access;
    if (!sa && !ra) return prefill.visibility || 'private';
    if (sa === 'private' && ra === 'private-edit') return 'private';
    if (sa === 'shared' && ra === 'shared-edit') return 'internal';
    return 'custom';
  })();

  const radio = (val: string, title: string, desc: string) => `
    <label class="visibility-option${preset === val ? ' selected' : ''}" data-value="${val}">
      <input type="radio" name="visibility" value="${val}"${preset === val ? ' checked' : ''} style="margin-right:0.5rem;">
      <span style="font-weight:600;color:#fdf6e8;">${escapeHtml(title)}</span>
      <span style="display:block;font-size:0.8rem;color:#a89878;margin-left:1.5rem;">${escapeHtml(desc)}</span>
    </label>
  `;

  // A project is its website plus any capabilities the user checks. The
  // website is always on (shown checked + disabled); database and MCP are
  // optional layers the platform composes into the repo.
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
      <p class="help" style="margin-bottom:1.25rem;">A project is a Gitea repo, an auto-deployed site at <code>&lt;slug&gt;.projects.corpo-valley.com</code>, and the wiring to point Claude Code at it.</p>

      <form method="POST" action="/projects" id="cv-project-form">
        ${csrf}

        <div class="field">
          <label for="name">What are you building?</label>
          <input type="text" name="name" id="name" value="${escapeHtml(prefill.name || '')}" required
                 placeholder="My farm stand"
                 autofocus>
          <p class="help" style="margin-top:0.4rem;">
            Your URL will be <code><span id="cv-slug-display" style="color:#e8b94a;">&lt;slug&gt;</span>.projects.corpo-valley.com</code>
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
            ${capCheckbox('mcp', !!prefill.mcp, false, 'Users can connect to this project via MCP', 'Adds an /mcp endpoint so AI agents can use this project as a tool.')}
          </div>
        </div>

        <div class="field">
          <label>Who can see it?</label>
          <div id="cv-visibility-group" style="display:flex;flex-direction:column;gap:0.4rem;">
            ${radio('private', 'Private', 'Only you can see the repo. The deployed site requires sign-in.')}
            ${radio('custom', 'Custom', 'Pick repo and service access independently in the advanced section below.')}
            ${radio('internal', 'Internal', 'Visible to other Corpo Valley members. The deployed site still requires sign-in — Corpo Valley does not publish projects publicly.')}
          </div>
        </div>

        <details style="margin:1rem 0;"${preset === 'custom' ? ' open' : ''}>
          <summary style="cursor:pointer;color:#a89878;font-size:0.85rem;">Advanced: customise per-axis access</summary>
          <div style="margin-top:0.6rem;padding-left:0.5rem;border-left:2px solid #5a4a36;">
            <p class="help">If you set either select below, it overrides the preset.</p>
            <div class="form-row">
              <div class="field">
                <label for="service_access">Service access</label>
                <select name="service_access" id="service_access"><option value="">(use preset)</option>${selectOptions(SERVICE_ACCESS_OPTS, prefill.service_access || '')}</select>
              </div>
              <div class="field">
                <label for="repo_access">Repo access</label>
                <select name="repo_access" id="repo_access"><option value="">(use preset)</option>${selectOptions(REPO_ACCESS_OPTS, prefill.repo_access || '')}</select>
              </div>
            </div>
          </div>
        </details>

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
        var advanced = document.querySelector('details');
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
            if (advanced && r.name === 'visibility' && r.value === 'custom') advanced.open = true;
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
  secretMessage: { type: 'error' | 'success'; text: string } | null = null
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
    ? `git clone https://gitea.corpo-valley.com/${escapeHtml(project.giteaRepo)}.git
cd ${escapeHtml(project.slug)}
claude`
    : '';

  // ── Overview card: name + live URL as the focal point; repo + created
  // are secondary metadata below.
  const overviewCard = `
    <div class="app-card">
      <h2 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:1.4rem;">${escapeHtml(project.name)}</h2>
      <div style="margin-bottom:0.5rem;">
        <a href="https://${escapeHtml(project.slug)}.projects.corpo-valley.com" target="_blank" rel="noopener" style="color:#e8b94a;font-size:0.95rem;">
          ${escapeHtml(project.slug)}.projects.corpo-valley.com ↗
        </a>
      </div>
      <div style="font-size:0.8rem;color:#a89878;">
        ${project.giteaRepo
          ? `<a href="https://gitea.corpo-valley.com/${escapeHtml(project.giteaRepo)}" target="_blank" rel="noopener" style="color:#a89878;text-decoration:underline;">${escapeHtml(project.giteaRepo)}</a> · `
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

      <h4 style="margin:0 0 0.35rem 0;color:#fdf6e8;font-size:0.95rem;">Access</h4>
      <p class="help" style="margin-bottom:0.75rem;">Who can see this project's running service and edit its repository.</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}">
        ${csrf}
        <div class="form-row">
          <div class="field">
            <label for="service_access">Service access</label>
            <select name="service_access" id="service_access">${selectOptions(SERVICE_ACCESS_OPTS, project.serviceAccess)}</select>
          </div>
          <div class="field">
            <label for="repo_access">Repo access</label>
            <select name="repo_access" id="repo_access">${selectOptions(REPO_ACCESS_OPTS, project.repoAccess)}</select>
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Save access</button>
      </form>
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

  // ── Danger zone: deliberately small, last, and styled to feel separate
  // from the rest. A hover-confirm prompt still gates the destructive POST.
  const dangerCard = `
    <div class="app-card" style="margin-top:1.25rem;border-color:#7f3d1d;">
      <h3 style="margin:0 0 0.35rem 0;color:#f3a5a5;">Danger zone</h3>
      <p class="help" style="margin-bottom:0.75rem;">Deleting removes this project record from the portal. Your Gitea repository and cluster namespace are not removed automatically — clean those up separately if you want them gone.</p>
      <form method="POST" action="/projects/${escapeHtml(project.id)}/delete"
            data-confirm="Delete project ${escapeHtml(project.slug)}? This cannot be undone.">
        ${csrf}
        <button type="submit" class="btn btn-danger">Delete project</button>
      </form>
    </div>
  `;

  const body = `
    <p style="margin-bottom:1rem;"><a href="/" class="btn btn-secondary btn-sm">← All projects</a></p>
    ${overviewCard}
    ${getStartedCard}
    ${configureCard}
    ${dbCard}
    ${dangerCard}
  `;
  return dashboardLayout(`Project: ${project.name}`, body, email, isAdmin, 'projects');
}

// ── API Keys ───────────────────────────────────────────────

export interface ApiKeyRow {
  clientId: string;
  createdAt: string;
}

// MCP server URL the editor configs point at. PUBLIC_MCP_URL is the
// resource identifier the RFC 9728 well-known announces (host only); the
// streamable-HTTP JSON-RPC endpoint is at <resource>/mcp.
const MCP_URL = (process.env.PUBLIC_MCP_URL || 'https://mcp.corpo-valley.com').replace(/\/+$/, '') + '/mcp';

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
        Full setup guide: <a href="/docs/mcp" style="color:#e8b94a;">portal.corpo-valley.com/docs/mcp ↗</a>
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
      <p class="help">Corpo Valley speaks the <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener" style="color:#e8b94a;">Model Context Protocol</a>. Once your editor knows about <code>mcp.corpo-valley.com</code> it can list and create your projects, mint Gitea credentials for cloning, seal secrets, and read its own documentation — all from the same chat where you're building.</p>

      <h2 style="font-size:1.1rem;color:#fdf6e8;margin-top:1.5rem;">Sign in once, then nothing to paste</h2>
      <p class="help">The server uses OAuth 2.1 with PKCE. The first time your editor connects, it pops a browser to <code>oauth.corpo-valley.com</code>, you sign in with your normal Corpo Valley account, and tokens land back in the editor. Refreshes happen silently afterwards.</p>

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
    ? `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@gitea.corpo-valley.com/${project.giteaRepo}.git`
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
  tier: string;
}

export function renderAdminUsers(
  users: UserRow[],
  page: number,
  hasMore: boolean,
  email: string
): string {
  let body = `<p style="margin-bottom:1rem;"><a href="/admin/users/new" class="btn btn-primary">Create User</a></p>`;

  body += `<div class="table-wrap"><table class="table">
    <thead><tr><th>Email</th><th>Username</th><th>Name</th><th>State</th><th>Tier</th><th></th></tr></thead>
    <tbody>`;
  for (const u of users) {
    body += `<tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${u.preferredUsername ? `<code>${escapeHtml(u.preferredUsername)}</code>` : '<span style="color:#8a7a5a">—</span>'}</td>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.state)}</td>
      <td>${tierBadge(u.tier)}</td>
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
  csrf: string = ''
): string {
  const tiers = ['EVERYONE', 'BETA', 'ALPHA', 'ADMIN'];
  const tierOptions = tiers.map(t =>
    `<option value="${t}"${t === user.tier ? ' selected' : ''}>${t}</option>`
  ).join('');

  const body = `
    <p style="margin-bottom:1rem;"><a href="/admin/users" class="btn btn-secondary btn-sm">Back to Users</a></p>
    <table class="table">
      <tr><th>State</th><td>${escapeHtml(user.state)}</td></tr>
      <tr><th>ID</th><td><code>${escapeHtml(user.id)}</code></td></tr>
      <tr><th>Tier</th><td>${tierBadge(user.tier)}</td></tr>
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

    <h3 style="margin-top:1.5rem;">Tier</h3>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}/tier">
      ${csrf}
      <div class="form-row">
        <div class="field">
          <label>Change Tier</label>
          <select name="tier">${tierOptions}</select>
        </div>
        <button type="submit" class="btn btn-primary">Update Tier</button>
      </div>
    </form>

    <h3 style="margin-top:1.5rem;">Password</h3>
    <p class="help">Issue a one-time recovery code the user can paste into the password-reset flow.</p>
    <form method="POST" action="/admin/users/${escapeHtml(user.id)}/recovery">
      ${csrf}
      <button type="submit" class="btn btn-secondary">Generate Recovery Code</button>
    </form>
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
  tier: string;
}

export function renderAdminApps(
  apps: AppRow[],
  email: string,
  csrf: string = ''
): string {
  const tiers = ['EVERYONE', 'BETA', 'ALPHA', 'ADMIN'];
  let body = `<p style="margin-bottom:1rem;"><a href="/admin/apps/register" class="btn btn-primary">Register New Service</a></p>`;

  body += `<div class="table-wrap"><table class="table">
    <thead><tr><th>Client ID</th><th>Name</th><th>Tier</th><th>Actions</th></tr></thead>
    <tbody>`;
  for (const app of apps) {
    const tierOptions = tiers.map(t =>
      `<option value="${t}"${t === app.tier ? ' selected' : ''}>${t}</option>`
    ).join('');

    body += `<tr>
      <td><code>${escapeHtml(app.clientId)}</code></td>
      <td>${escapeHtml(app.clientName)}</td>
      <td>
        <form method="POST" action="/admin/apps/${escapeHtml(app.clientId)}/tier" class="inline-form">
          ${csrf}
          <select name="tier">${tierOptions}</select>
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

export function renderAdminTemplate(
  status: TemplateStatusView,
  result: TemplateResetView | null,
  email: string,
  csrf: string = ''
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

  return dashboardLayout('Project Template', body, email, true, 'template');
}

export function renderAdminRegisterForm(email: string, csrf: string = ''): string {
  const tiers = ['EVERYONE', 'BETA', 'ALPHA', 'ADMIN'];
  const tierOptions = tiers.map(t => `<option value="${t}">${t}</option>`).join('');

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
        <label>Tier</label>
        <select name="tier">${tierOptions}</select>
      </div>
      <div class="field">
        <label>Redirect URI</label>
        <input type="text" name="redirectUri" placeholder="https://app.corpo-valley.com/auth/callback">
      </div>
      <button type="submit" class="btn btn-primary" style="width:auto;">Register</button>
    </form>
  `;
  return dashboardLayout('Register Service', body, email, true, 'apps');
}

export function renderAdminRegisterResult(
  clientId: string,
  clientSecret: string,
  tier: string,
  email: string
): string {
  const body = `
    <div class="message success">Service registered successfully.</div>
    <p class="key-warning">Save these credentials now. The secret will not be shown again.</p>
    <div class="key-display">
      <strong>Client ID:</strong><br>${escapeHtml(clientId)}<br><br>
      <strong>Client Secret:</strong><br>${escapeHtml(clientSecret)}<br><br>
      <strong>Tier:</strong><br>${tierBadge(tier)}
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
  if (oidc.length > 0) {
    body += `<form action="${escapeHtml(action)}" method="POST">
      ${hiddenCsrf(csrf)}
      ${oidc.map(oidcButtonHtml).join('')}
    </form>`;
    if (hasPassword || hasCodeSubmit) body += '<div class="divider">or</div>';
  }

  if (hasPassword || hasCodeSubmit) {
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
