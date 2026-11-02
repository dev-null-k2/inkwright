/**
 * The built-in API reference at /api/v1/docs: one self-contained HTML page (no CDN, works
 * offline and behind a tunnel) that reads /api/v1/openapi.json and renders every operation with
 * its scope, parameters, body and responses, a curl example, and the problem codes (each with an
 * anchor that problem `type` URIs point at).
 */
import { PROBLEM_CODES } from './core.ts';

const PROBLEM_TEXT: Record<keyof typeof PROBLEM_CODES, string> = {
  invalid_request: 'The path, query or body is not valid. `errors` lists every problem as {path, message}.',
  unauthorized: 'No API key or token was sent, or it is wrong, revoked or expired.',
  forbidden: 'The request is not allowed from where it came (for example a non-loopback origin without a key).',
  insufficient_scope: 'The key is valid but lacks the scope this operation needs. Create a key with that scope.',
  not_found: 'There is no such operation, note, page, notebook, webhook or key.',
  method_not_allowed: 'The path exists but not with this method; see the Allow header.',
  not_acceptable: 'The server cannot produce the requested format.',
  conflict: 'The request conflicts with the current state.',
  idempotency_key_in_use: 'A request with the same Idempotency-Key is still running. Retry after a moment.',
  precondition_failed: 'If-Match did not match the note’s current ETag: someone changed it since you read it. Read it again, then retry.',
  payload_too_large: 'The body is larger than the server accepts (4 MiB by default).',
  unsupported_media_type: 'Bodies must be JSON with Content-Type: application/json.',
  idempotency_key_reused: 'The Idempotency-Key was already used for a different request. Use a fresh key per request.',
  rate_limited: 'Too many requests from this key. Wait for Retry-After seconds.',
  internal: 'An unexpected error on the server. Its log has details.',
  not_implemented: 'The feature needs something the server does not have (PNG/PDF need @resvg/resvg-js; semantic search needs an embedding model).',
  unavailable: 'A dependency is missing, e.g. routines need the server to have an AI configured.',
  read_only: 'The vault is served read-only (--read-only).',
  locked: 'The note is locked with a passcode; its content cannot be changed through the API.',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function docsPage(specUrl: string): string {
  const problems = Object.entries(PROBLEM_CODES)
    .map(([code, status]) => `<dt id="problem-${code.replace(/_/g, '-')}"><code>${code}</code> <span class="st">${status}</span></dt><dd>${esc(PROBLEM_TEXT[code as keyof typeof PROBLEM_CODES])}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inkstone API</title>
<style>
:root{--desk:#efeae4;--paper:#fbf8f3;--ink:#1d1a20;--muted:#6b6470;--line:#ddd5cc;--eye:#2f7f6f;--seal:#b23a2c;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--desk:#17141a;--paper:#211d24;--ink:#ece6ef;--muted:#a59dab;--line:#3a333f;--eye:#6cc0ac;--seal:#e07a6c}}
*{box-sizing:border-box}body{margin:0;background:var(--desk);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 20px 80px}h1{font:600 30px/1.2 ui-serif,Georgia,serif;margin:0 0 6px}
h2{font:600 21px/1.3 ui-serif,Georgia,serif;margin:40px 0 10px}p.lede{color:var(--muted);margin:0 0 24px}
.op{background:var(--paper);border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}
.op>summary{display:flex;gap:12px;align-items:baseline;padding:12px 16px;cursor:pointer;list-style:none}.op>summary::-webkit-details-marker{display:none}
.m{font:600 12px ui-monospace,monospace;min-width:56px}.m.GET{color:var(--eye)}.m.DELETE{color:var(--seal)}
.p{font:13px ui-monospace,monospace}.s{color:var(--muted);margin-left:auto;text-align:right}
.body{padding:4px 16px 16px;border-top:1px solid var(--line)}code,pre{font:12.5px/1.5 ui-monospace,monospace}
pre{background:var(--desk);border-radius:8px;padding:10px 12px;overflow:auto;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.scope{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;color:var(--muted)}
dt{margin-top:10px}dd{margin:2px 0 0 0;color:var(--muted)}.st{color:var(--muted);font-size:13px}a{color:var(--eye)}
</style></head>
<body><main>
<h1>Inkstone API</h1>
<p class="lede">REST over your notes vault. Machine-readable: <a href="${specUrl}">openapi.json</a> (OpenAPI 3.1). Send <code>Authorization: Bearer ink_…</code> with an API key from Settings › Developer or <code>inkstone-mcp keys create</code>.</p>
<div id="ops">Loading…</div>
<h2 id="problems">Errors</h2>
<p>Errors are <code>application/problem+json</code> (RFC 9457) with a stable <code>code</code>:</p>
<dl>${problems}</dl>
<h2 id="webhooks">Webhooks</h2>
<p>Deliveries follow the <a href="https://www.standardwebhooks.com">Standard Webhooks</a> spec: verify <code>webhook-signature</code> (<code>v1,</code> + base64 HMAC-SHA256 of <code>id.timestamp.body</code> keyed with the base64 part of your <code>whsec_</code> secret), reject timestamps older than 5 minutes, and de-duplicate by <code>webhook-id</code>. Failed deliveries are retried after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h.</p>
</main>
<script>
(async () => {
  const el = document.getElementById('ops');
  const spec = await (await fetch(${JSON.stringify(specUrl)})).json();
  const base = spec.servers[0].url;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const schemaText = (s) => {
    if (!s) return '';
    if (s.$ref) return s.$ref.split('/').pop();
    if (s.type === 'array') return schemaText(s.items) + '[]';
    if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    return s.type ? [].concat(s.type).join(' | ') : 'any';
  };
  const byTag = new Map();
  for (const [path, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(ops)) {
    const t = (op.tags || ['Other'])[0];
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t).push({ path, method: method.toUpperCase(), op });
  }
  let html = '';
  for (const tag of spec.tags.map((t) => t.name).filter((t) => byTag.has(t))) {
    const info = spec.tags.find((t) => t.name === tag);
    html += '<h2 id="' + tag.toLowerCase() + '">' + esc(tag) + '</h2><p class="lede">' + esc(info && info.description) + '</p>';
    for (const { path, method, op } of byTag.get(tag)) {
      const params = (op.parameters || []).map((p) => '<tr><td><code>' + esc(p.name) + '</code></td><td>' + p.in + (p.required ? ', required' : '') + '</td><td><code>' + esc(schemaText(p.schema)) + '</code>' + (p.schema && p.schema.default !== undefined ? ' = ' + esc(JSON.stringify(p.schema.default)) : '') + '</td><td>' + esc(p.description) + '</td></tr>').join('');
      const body = op.requestBody ? '<p>Body: <code>' + esc(schemaText(op.requestBody.content['application/json'].schema)) + '</code></p><pre>' + esc(JSON.stringify(spec.components.schemas[schemaText(op.requestBody.content['application/json'].schema)], null, 2)) + '</pre>' : '';
      const resps = Object.entries(op.responses).filter(([, r]) => !r.$ref).map(([code, r]) => '<tr><td>' + code + '</td><td>' + esc(r.description) + '</td><td><code>' + esc(r.content ? Object.entries(r.content).map(([t, c]) => t + (c.schema && c.schema.$ref ? ' ' + schemaText(c.schema) : '')).join(', ') : '') + '</code></td></tr>').join('');
      const sample = path.replace(/\\{(\\w+)\\}/g, (_m, n) => n === 'n' ? '1' : '<' + n + '>');
      const curl = 'curl -s ' + (method === 'GET' ? '' : '-X ' + method + ' ') + '"' + base + sample + '" \\\\\\n  -H "Authorization: Bearer $INKSTONE_API_KEY"' + (op.requestBody ? ' \\\\\\n  -H "Content-Type: application/json" -d \\'{…}\\'' : '');
      const scope = op['x-inkstone-scope'];
      html += '<details class="op" id="' + op.operationId + '"><summary><span class="m ' + method + '">' + method + '</span><span class="p">' + esc(path) + '</span><span class="s">' + esc(op.summary) + '</span></summary><div class="body">' +
        '<p>' + esc(op.description || op.summary) + ' ' + (scope ? '<span class="scope">' + esc(scope) + '</span>' : '') + ' <span class="scope">' + op.operationId + '</span></p>' +
        (params ? '<table><tr><th>Parameter</th><th>In</th><th>Type</th><th></th></tr>' + params + '</table>' : '') + body +
        '<table><tr><th>Status</th><th>Meaning</th><th>Body</th></tr>' + resps + '</table><pre>' + esc(curl) + '</pre></div></details>';
    }
  }
  el.innerHTML = html;
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})().catch((e) => { document.getElementById('ops').textContent = 'Could not load the API description: ' + e.message; });
</script>
</body></html>`;
}
