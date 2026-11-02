/**
 * A webhook receiver: subscribes itself to note and recording events, verifies each delivery's
 * signature (Standard Webhooks) and prints it. Duplicate deliveries (retries) are skipped by id.
 *
 *   INKSTONE_API_KEY=ink_… npx tsx packages/sdk/examples/webhook-receiver.ts
 */
import { createServer } from 'node:http';
import { InkstoneClient, verifyWebhook, type WebhookMessage } from '@inkstone/sdk';

const port = Number(process.env.PORT ?? 8790);
const inkstone = new InkstoneClient({ baseUrl: process.env.INKSTONE_API_URL ?? 'http://127.0.0.1:8765/api/v1', apiKey: process.env.INKSTONE_API_KEY });

const hook = await inkstone.createWebhook({ body: { url: `http://127.0.0.1:${port}/inkstone`, events: ['note.created', 'note.updated', 'recording.ended'], description: 'SDK example' } });
console.log(`Subscribed (${hook.id}). Write something in Inkstone…`);

const seen = new Set<string>();
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (!(await verifyWebhook(hook.secret, req.headers as Record<string, string>, body))) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(204).end(); // answer fast; do slow work afterwards
    const id = String(req.headers['webhook-id']);
    if (seen.has(id)) return;
    seen.add(id);
    const msg = JSON.parse(body) as WebhookMessage<{ id?: string; title?: string }>;
    console.log(`${msg.timestamp} ${msg.type}: ${msg.data.title ?? JSON.stringify(msg.data)}`);
  });
}).listen(port, '127.0.0.1');

process.on('SIGINT', async () => {
  await inkstone.deleteWebhook({ id: hook.id });
  process.exit(0);
});
