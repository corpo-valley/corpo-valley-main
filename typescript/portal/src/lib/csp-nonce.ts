import { AsyncLocalStorage } from 'async_hooks';

// Per-request CSP nonce. The security-headers middleware generates a nonce,
// puts it in the Content-Security-Policy `script-src 'nonce-...'`, and runs the
// rest of the request inside this store. The pure string-building templates read
// it via cspNonce() so every inline <script> they emit carries the matching
// nonce — letting us drop `'unsafe-inline'` from script-src.
const store = new AsyncLocalStorage<string>();

export function runWithNonce<T>(nonce: string, fn: () => T): T {
  return store.run(nonce, fn);
}

export function cspNonce(): string {
  return store.getStore() || '';
}
