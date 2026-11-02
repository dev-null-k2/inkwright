/**
 * `@inkstone/sdk` — a typed client for the Inkstone REST API (docs/API.md).
 *
 * ```ts
 * import { InkstoneClient, paginate } from '@inkstone/sdk';
 * const inkstone = new InkstoneClient({ baseUrl: 'http://127.0.0.1:8765/api/v1', apiKey: process.env.INKSTONE_API_KEY });
 * const note = await inkstone.createNote({ body: { title: 'From a script', text: 'Hello' } });
 * for await (const n of paginate((cursor) => inkstone.listNotes({ cursor, tag: 'work' }))) console.log(n.title);
 * ```
 */
export * from './generated.ts';
export { BaseClient, InkstoneApiError, paginate, verifyWebhook, type ClientOptions, type ProblemDetails, type RequestOptions, type ResponseMeta, type WebhookMessage } from './runtime.ts';
