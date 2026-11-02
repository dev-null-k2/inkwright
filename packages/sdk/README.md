# @inkwright/sdk

A typed TypeScript client for the Inkwright REST API (`inkwright-mcp --http`, see
[docs/API.md](../../docs/API.md)). The types and one method per operation are generated from the
API's OpenAPI 3.1 document, so they always match the server; the runtime (auth, retries, errors,
pagination, webhook verification) is a few hundred lines with no dependencies. It runs anywhere
with `fetch` and Web Crypto: Node 20+, Deno, Bun, browsers and edge workers.

```ts
import { InkwrightClient, InkwrightApiError, paginate, verifyWebhook } from '@inkwright/sdk';

const inkwright = new InkwrightClient({ baseUrl: 'http://127.0.0.1:8765/api/v1', apiKey: process.env.INKWRIGHT_API_KEY });

const note = await inkwright.createNote({ body: { title: 'Standup', text: '- shipped the API' } });
await inkwright.appendToNote({ id: note.id, body: { text: '- next: plugins' } });
const svg = await inkwright.getPageSvg({ id: note.id, n: 1 });

for await (const n of paginate((cursor) => inkwright.listNotes({ tag: 'work', cursor }))) console.log(n.title);
```

- **Errors** are `InkwrightApiError` with `status`, the stable `code` (`not_found`,
  `precondition_failed`, `insufficient_scope`, …) and the full RFC 9457 `problem`.
- **Safe retries:** GETs and POSTs that create or run something are retried on 429/5xx/network
  errors (honouring `Retry-After`); POSTs carry an automatic `Idempotency-Key`, so a retry never
  creates a second note. Pass `{ idempotencyKey }` to choose your own.
- **ETags:** after a read, `client.lastResponse.etag`; pass it as `{ ifMatch }` to updates (412 if
  the note changed) or `{ ifNoneMatch }` to reads (`null` when unchanged).
- **Webhooks:** `await verifyWebhook(secret, request.headers, rawBody)`.

Examples: [`examples/quickstart.ts`](examples/quickstart.ts),
[`examples/webhook-receiver.ts`](examples/webhook-receiver.ts).

Regenerate after changing the API: `npm run generate -w @inkwright/sdk` (a test fails while
`src/generated.ts` is stale).
