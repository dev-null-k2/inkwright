/**
 * Quick start: create a note, read it back, change it safely and list notes by tag.
 *
 *   inkstone-mcp --vault ~/Inkstone --http 8765 &
 *   export INKSTONE_API_KEY=$(inkstone-mcp keys create --vault ~/Inkstone --name quickstart --scope notes:read --scope notes:write --json | jq -r .key)
 *   npx tsx packages/sdk/examples/quickstart.ts
 */
import { InkstoneApiError, InkstoneClient, paginate } from '@inkstone/sdk';

const inkstone = new InkstoneClient({
  baseUrl: process.env.INKSTONE_API_URL ?? 'http://127.0.0.1:8765/api/v1',
  apiKey: process.env.INKSTONE_API_KEY,
});

const note = await inkstone.createNote({ body: { title: 'Ideas from the train', text: '- Try the blue notebook\n- Call Sam', tags: ['ideas'] } });
console.log(`Created ${note.title} (${note.id})`);

// Read it, then update with If-Match so a change made meanwhile (on the phone, by an agent) is never overwritten.
await inkstone.getNote({ id: note.id });
const etag = inkstone.lastResponse?.etag ?? undefined;
try {
  await inkstone.updateNote({ id: note.id, body: { tags: ['ideas', 'travel'] } }, { ifMatch: etag });
} catch (e) {
  if (e instanceof InkstoneApiError && e.code === 'precondition_failed') console.log('Someone changed the note first; read it again and retry.');
  else throw e;
}

for await (const n of paginate((cursor) => inkstone.listNotes({ tag: 'ideas', cursor }))) {
  console.log(`${n.updatedAt}  ${n.title}  [${n.tags.join(', ')}]`);
}

const hits = await inkstone.search({ q: 'blue notebook' });
for (const h of hits.data) console.log(`${h.title} p.${h.page}: ${h.snippet}`);
