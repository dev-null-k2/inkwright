// My plugin — made from the Inkstone plugin template (docs/PLUGINS.md).
//
// One ES module, no build step needed. It runs sandboxed: everything goes through `inkstone`,
// and only the permissions in manifest.json are granted.

/** @typedef {import('@inkstone/plugin-api').InkstoneAPI} InkstoneAPI */

export default {
  /** Runs once when the plugin starts. @param {InkstoneAPI} inkstone */
  activate(inkstone) {
    inkstone.commands.register('hello', async () => {
      const { greeting } = await inkstone.settings.get();
      const open = await inkstone.editor.current();
      await inkstone.ui.toast(`${greeting}${open ? `, “${open.title}” is open` : ''}!`, 'success');
    });
  },

  panels: {
    /** Renders in its own sandboxed frame. @param {HTMLElement} root @param {InkstoneAPI} inkstone */
    async main(root, inkstone) {
      const selected = await inkstone.editor.selection();
      root.innerHTML = '<p>Select something in the note.</p><p data-sel style="color: var(--ink-2)"></p>';
      const out = root.querySelector('[data-sel]');
      out.textContent = selected;
      // Needs the "events" permission to hear about selection changes; ask for it in manifest.json.
      inkstone.events.on('selection.changed', (e) => { out.textContent = e.text; });
    },
  },
};
