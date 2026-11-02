// Word count & reading time — an example Inkstone plugin (docs/PLUGINS.md).
//
// Plain JavaScript, one ES module, no build step. The JSDoc types come from @inkstone/plugin-api.
// Runs in a sandbox: it can only reach notes through `inkstone`, with the permissions in its manifest.

/** @typedef {import('@inkstone/plugin-api').InkstoneAPI} InkstoneAPI */

/** Markdown → plain words: drops front matter, link brackets, emphasis and list markers. */
export function plainText(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t, alias) => alias || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/[*_`~>]/g, '');
}

/** Words, characters and minutes to read. Counts CJK characters as words. */
export function stats(text, wordsPerMinute = 230) {
  const plain = plainText(text);
  const cjk = (plain.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  const words = (plain.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length + cjk;
  const characters = plain.replace(/\s+/g, '').length;
  const minutes = words / Math.max(60, Number(wordsPerMinute) || 230);
  return { words, characters, minutes };
}

const readingTime = (m) => (m < 1 ? 'under a minute' : `${Math.round(m)} min`);

async function wpm(inkstone) {
  const s = await inkstone.settings.get();
  return Number(s.wordsPerMinute) || 230;
}

export default {
  /** @param {InkstoneAPI} inkstone */
  activate(inkstone) {
    inkstone.commands.register('count', async () => {
      const open = await inkstone.editor.current();
      if (!open) return inkstone.ui.toast('Open a note first.');
      const note = await inkstone.notes.get(open.noteId);
      const s = stats(note.markdown, await wpm(inkstone));
      await inkstone.ui.toast(`“${note.title}”: ${s.words.toLocaleString()} words · ${readingTime(s.minutes)} to read`, 'success');
    });

    inkstone.ai.registerTool('reading_time', async ({ noteId }) => {
      const note = await inkstone.notes.get(String(noteId));
      const s = stats(note.markdown, await wpm(inkstone));
      return { title: note.title, words: s.words, characters: s.characters, minutes: Math.round(s.minutes * 10) / 10 };
    });

    inkstone.exporters.register('plain-text', ({ note }) => ({ text: plainText(note.markdown).replace(/\n{3,}/g, '\n\n').trim() + '\n', fileName: note.title }));
  },

  panels: {
    /**
     * Renders in the panel's own sandboxed frame.
     * @param {HTMLElement} root
     * @param {InkstoneAPI} inkstone
     */
    async stats(root, inkstone) {
      root.innerHTML = `
        <style>
          .wc { display: grid; gap: 14px; padding: 4px 2px; }
          .wc-row { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
          .wc-n { font-family: var(--font-title); font-size: 26px; }
          .wc-l { color: var(--ink-2); }
          .wc-h { margin: 6px 0 0; font-size: 13px; color: var(--ink-3); }
        </style>
        <div class="wc" aria-live="polite">
          <div class="wc-row"><span class="wc-l">Words</span><span class="wc-n" data-k="words">–</span></div>
          <div class="wc-row"><span class="wc-l">Characters</span><span class="wc-n" data-k="characters">–</span></div>
          <div class="wc-row"><span class="wc-l">Reading time</span><span class="wc-n" data-k="time">–</span></div>
          <p class="wc-h" data-k="selection"></p>
        </div>`;
      const set = (k, v) => { root.querySelector(`[data-k="${k}"]`).textContent = v; };

      let noteId = null;
      const refresh = async () => {
        const open = await inkstone.editor.current();
        if (!open) return set('selection', 'Open a note to count its words.');
        noteId = open.noteId;
        const note = await inkstone.notes.get(open.noteId);
        const s = stats(note.markdown, await wpm(inkstone));
        set('words', s.words.toLocaleString());
        set('characters', s.characters.toLocaleString());
        set('time', readingTime(s.minutes));
      };
      const showSelection = (text) => {
        if (!text) return set('selection', 'Select ink or text to count just that.');
        const s = stats(text);
        set('selection', `Selection: ${s.words.toLocaleString()} words, ${s.characters.toLocaleString()} characters`);
      };

      await refresh();
      showSelection(await inkstone.editor.selection());
      inkstone.events.on('note.updated', (e) => { if (e.id === noteId) void refresh(); });
      inkstone.events.on('note.opened', () => void refresh());
      inkstone.events.on('selection.changed', (e) => showSelection(e.text));
    },
  },
};
