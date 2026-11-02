/**
 * `@inkwright/sdk` — a typed client for the Inkwright REST API (docs/API.md).
 *
 * ```ts
 * import { InkwrightClient, paginate } from '@inkwright/sdk';
 * const inkwright = new InkwrightClient({ baseUrl: 'http://127.0.0.1:8765/api/v1', apiKey: process.env.INKWRIGHT_API_KEY });
 * const note = await inkwright.createNote({ body: { title: 'From a script', text: 'Hello' } });
 * for await (const n of paginate((cursor) => inkwright.listNotes({ cursor, tag: 'work' }))) console.log(n.title);
 * ```
 */
export * from './generated.ts';
export { BaseClient, InkwrightApiError, paginate, verifyWebhook, type ClientOptions, type ProblemDetails, type RequestOptions, type ResponseMeta, type WebhookMessage } from './runtime.ts';
