/**
 * Quick start: create a note, read it back, change it safely and list notes by tag.
 *
 *   inkwright-mcp --vault ~/Inkwright --http 8765 &
 *   export INKWRIGHT_API_KEY=$(inkwright-mcp keys create --vault ~/Inkwright --name quickstart --scope notes:read --scope notes:write --json | jq -r .key)
 *   npx tsx packages/sdk/examples/quickstart.ts
 */
import { InkwrightApiError, InkwrightClient, paginate } from '@inkwright/sdk';

const inkwright = new InkwrightClient({
  baseUrl: process.env.INKWRIGHT_API_URL ?? 'http://127.0.0.1:8765/api/v1',
  apiKey: process.env.INKWRIGHT_API_KEY,
});

const note = await inkwright.createNote({ body: { title: 'Ideas from the train', text: '- Try the blue notebook\n- Call Sam', tags: ['ideas'] } });
console.log(`Created ${note.title} (${note.id})`);

// Read it, then update with If-Match so a change made meanwhile (on the phone, by an agent) is never overwritten.
await inkwright.getNote({ id: note.id });
const etag = inkwright.lastResponse?.etag ?? undefined;
try {
  await inkwright.updateNote({ id: note.id, body: { tags: ['ideas', 'travel'] } }, { ifMatch: etag });
} catch (e) {
  if (e instanceof InkwrightApiError && e.code === 'precondition_failed') console.log('Someone changed the note first; read it again and retry.');
  else throw e;
}

for await (const n of paginate((cursor) => inkwright.listNotes({ tag: 'ideas', cursor }))) {
  console.log(`${n.updatedAt}  ${n.title}  [${n.tags.join(', ')}]`);
}

const hits = await inkwright.search({ q: 'blue notebook' });
for (const h of hits.data) console.log(`${h.title} p.${h.page}: ${h.snippet}`);
