import type { ScriptContext } from '../src/index.ts';
import { WRITE_TOOLS, called, calledOnce, noteTexts, notCalled, replyMatches, state, type EvalCase } from './harness.ts';

/** First search hit's note id from the previous turn's search_notes result. */
const firstHit = (ctx: ScriptContext): string => (ctx.toolResults[0]?.value as { results?: Array<{ note_id: string }> })?.results?.[0]?.note_id ?? 'none';

export const AGENT_CASES: EvalCase[] = [
  {
    id: 'search-launch',
    description: '"Find my notes about X" must search and name the matching note.',
    prompt: 'Find my notes about the launch',
    async setup(host) {
      const launch = await host.seed({ title: 'Beta launch plan', text: 'Launch date: March 3. Owner: Priya. Press embargo until 9am.' });
      await host.seed({ title: 'Groceries', text: 'eggs, milk, coffee' });
      await host.seed({ title: 'Reading list', text: 'Dune, Piranesi' });
      return { launch: launch.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'launch' } }] },
      (ctx) => ({ text: `I found one note: [${(ctx.toolResults[0]!.value as any).results[0].title}] — launch date March 3.` }),
    ],
    checks: [
      called('search_notes', (a) => /launch/i.test(String(a.query)), 'searches for "launch"', 2),
      notCalled(WRITE_TOOLS, 'makes no changes'),
      replyMatches(/Beta launch plan/, 'names the note'),
    ],
  },
  {
    id: 'grocery-note',
    description: '"Make a note with my grocery list" must create one note containing every item.',
    prompt: 'Make a note with my grocery list: eggs, milk, spinach and coffee',
    script: [
      { toolCalls: [{ name: 'create_note', arguments: { title: 'Grocery list', text: '- [ ] Eggs\n- [ ] Milk\n- [ ] Spinach\n- [ ] Coffee', tags: ['groceries'] } }] },
      { text: 'Saved your grocery list as a new note, [Grocery list].' },
    ],
    checks: [
      called('create_note', (a) => ['eggs', 'milk', 'spinach', 'coffee'].every((w) => String(a.text).toLowerCase().includes(w)), 'create_note text has all 4 items', 2),
      calledOnce('create_note'),
      state('vault has a note with all items', async (r) => {
        for (const text of (await noteTexts(r.host)).values()) if (['eggs', 'milk', 'spinach', 'coffee'].every((w) => text.toLowerCase().includes(w))) return true;
        return false;
      }, 2),
      notCalled(['trash_note', 'append_to_note'], 'no unrelated writes'),
    ],
  },
  {
    id: 'trash-declined',
    description: 'Deleting needs confirmation; when the user declines, nothing is deleted and the agent says so.',
    prompt: 'Delete my old shopping list note',
    confirm: false,
    async setup(host) {
      const old = await host.seed({ title: 'Old shopping list', text: 'bananas, rice, dish soap' });
      await host.seed({ title: 'Shopping ideas for mom', text: 'scarf, tea set' });
      return { old: old.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'old shopping list' } }] },
      (ctx) => ({ toolCalls: [{ name: 'trash_note', arguments: { note_id: firstHit(ctx) } }] }),
      { text: "Okay — I didn't delete [Old shopping list] since you declined." },
    ],
    checks: [
      called('trash_note', (a, r) => a.note_id === r.ids.old, 'targets the right note', 2),
      state('user was asked to confirm', (r) => r.confirmAsked.includes('trash_note'), 2),
      state('note is NOT trashed', async (r) => (await r.host.readNote(r.ids.old!)) !== null, 2),
      state('other note untouched', async (r) => (await r.host.listNotes()).some((n) => n.title === 'Shopping ideas for mom')),
      replyMatches(/\b(not|didn't|did not|declined|cancel|won't|haven't)\b/i, 'tells the user it was not deleted'),
    ],
  },
  {
    id: 'trash-confirmed',
    description: 'When the user confirms, the right note goes to the Trash.',
    prompt: 'Please delete my old shopping list note',
    confirm: true,
    async setup(host) {
      const old = await host.seed({ title: 'Old shopping list', text: 'bananas, rice, dish soap' });
      const keep = await host.seed({ title: 'Shopping ideas for mom', text: 'scarf, tea set' });
      return { old: old.id, keep: keep.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'old shopping list' } }] },
      (ctx) => ({ toolCalls: [{ name: 'trash_note', arguments: { note_id: firstHit(ctx) } }] }),
      { text: 'Moved [Old shopping list] to the Trash.' },
    ],
    checks: [
      state('user was asked to confirm', (r) => r.confirmAsked.includes('trash_note')),
      state('right note trashed', async (r) => (await r.host.readNote(r.ids.old!)) === null, 2),
      state('other note kept', async (r) => (await r.host.readNote(r.ids.keep!)) !== null, 2),
    ],
  },
  {
    id: 'append-to-wedding',
    description: '"Add X to my … note" must append to that note, not create a new one.',
    prompt: "Add 'call the florist' to my wedding planning note",
    async setup(host) {
      const w = await host.seed({ title: 'Wedding planning', text: 'Venue: the old mill\nDate: June 14' });
      await host.seed({ title: 'Work planning', text: 'Q3 roadmap' });
      return { wedding: w.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'wedding planning' } }] },
      (ctx) => ({ toolCalls: [{ name: 'append_to_note', arguments: { note_id: firstHit(ctx), text: '- [ ] Call the florist' } }] }),
      { text: 'Added "Call the florist" to [Wedding planning].' },
    ],
    checks: [
      called('append_to_note', (a, r) => a.note_id === r.ids.wedding && /florist/i.test(String(a.text)), 'appends to the wedding note', 2),
      notCalled(['create_note', 'trash_note'], 'does not create or delete notes'),
      state('wedding note has florist + original text', async (r) => {
        const text = (await noteTexts(r.host)).get('Wedding planning') ?? '';
        return /florist/i.test(text) && text.includes('the old mill');
      }, 2),
    ],
  },
  {
    id: 'answer-from-note',
    description: 'Questions about note content must be answered from the note (reading it), without edits.',
    prompt: 'What marketing budget did we approve in the Q3 planning meeting?',
    async setup(host) {
      const q3 = await host.seed({ title: 'Q3 planning meeting', recognizedText: 'Attendees: Ana, Raj, Mei\nDecisions:\n- Marketing budget approved: $12,000\n- Hire one designer', strokes: 12 });
      await host.seed({ title: 'Q2 planning meeting', text: 'Marketing budget approved: $8,000' });
      return { q3: q3.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'Q3 planning budget' } }] },
      (ctx) => ({ toolCalls: [{ name: 'read_note', arguments: { note_id: firstHit(ctx) } }] }),
      { text: 'You approved a $12,000 marketing budget [Q3 planning meeting].' },
    ],
    checks: [
      called('search_notes', undefined, 'looks the note up'),
      called('read_note', (a, r) => a.note_id === r.ids.q3, 'reads the Q3 note'),
      replyMatches(/12[,.]?000|12k/i, 'answers $12,000', 2),
      notCalled(WRITE_TOOLS, 'makes no changes'),
    ],
  },
  {
    id: 'organize-notebook',
    description: 'Multi-step organization: create a notebook and move a note into it.',
    prompt: 'Create a notebook called Recipes and move my pancake note into it',
    async setup(host) {
      const p = await host.seed({ title: 'Pancakes', text: '2 eggs, 1 cup flour, 1 cup milk' });
      return { pancakes: p.id };
    },
    script: [
      { toolCalls: [{ name: 'create_notebook', arguments: { name: 'Recipes' } }, { name: 'search_notes', arguments: { query: 'pancake' } }] },
      (ctx) => {
        const nb = (ctx.toolResults[0]!.value as any).notebook.id;
        const note = (ctx.toolResults[1]!.value as any).results[0].note_id;
        return { toolCalls: [{ name: 'update_note', arguments: { note_id: note, notebook_id: nb } }] };
      },
      { text: 'Created the Recipes notebook and moved [Pancakes] into it.' },
    ],
    checks: [
      called('create_notebook', (a) => /^recipes$/i.test(String(a.name).trim()), 'creates "Recipes"'),
      state('exactly one Recipes notebook', async (r) => (await r.host.listNotebooks()).filter((n) => /^recipes$/i.test(n.name)).length === 1),
      state('pancake note is in Recipes', async (r) => {
        const nb = (await r.host.listNotebooks()).find((n) => /^recipes$/i.test(n.name));
        const note = (await r.host.listNotes()).find((n) => n.id === r.ids.pancakes);
        return !!nb && note?.notebookId === nb.id;
      }, 2),
      notCalled(['trash_note', 'create_note'], 'no other writes'),
    ],
  },
  {
    id: 'retag-keeps-tags',
    description: 'Adding a tag must keep the existing tags (update_note replaces the list).',
    prompt: 'Tag my Lecture 7 note with biology too',
    async setup(host) {
      const l = await host.seed({ title: 'Lecture 7', text: 'Photosynthesis', tags: ['school', 'notes'] });
      return { lecture: l.id };
    },
    script: [
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'Lecture 7' } }] },
      (ctx) => ({ toolCalls: [{ name: 'read_note', arguments: { note_id: firstHit(ctx) } }] }),
      (ctx) => {
        const n = ctx.toolResults[0]!.value as any;
        return { toolCalls: [{ name: 'update_note', arguments: { note_id: n.id, tags: [...(n.tags ?? []), 'biology'] } }] };
      },
      { text: 'Added the biology tag to [Lecture 7].' },
    ],
    checks: [
      called('update_note', undefined, 'updates the note'),
      state('has biology tag', async (r) => (await r.host.readNote(r.ids.lecture!))?.meta.tags.includes('biology') ?? false, 2),
      state('kept existing tags', async (r) => {
        const tags = (await r.host.readNote(r.ids.lecture!))?.meta.tags ?? [];
        return tags.includes('school') && tags.includes('notes');
      }, 2),
    ],
  },
  {
    id: 'chitchat-no-writes',
    description: 'Small talk must not trigger any write tool.',
    prompt: 'Hi! What can you help me with?',
    script: [{ text: 'I can search, read, summarize and organize your notes — and create new ones. What would you like to do?' }],
    checks: [notCalled(WRITE_TOOLS, 'no writes', 2), replyMatches(/\S{3,}/, 'replies')],
  },
];
