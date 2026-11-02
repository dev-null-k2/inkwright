// My plugin — made from the Inkwright plugin template (docs/PLUGINS.md).
//
// One ES module, no build step needed. It runs sandboxed: everything goes through `inkwright`,
// and only the permissions in manifest.json are granted.

/** @typedef {import('@inkwright/plugin-api').InkwrightAPI} InkwrightAPI */

export default {
  /** Runs once when the plugin starts. @param {InkwrightAPI} inkwright */
  activate(inkwright) {
    inkwright.commands.register('hello', async () => {
      const { greeting } = await inkwright.settings.get();
      const open = await inkwright.editor.current();
      await inkwright.ui.toast(`${greeting}${open ? `, “${open.title}” is open` : ''}!`, 'success');
    });
  },

  panels: {
    /** Renders in its own sandboxed frame. @param {HTMLElement} root @param {InkwrightAPI} inkwright */
    async main(root, inkwright) {
      const selected = await inkwright.editor.selection();
      root.innerHTML = '<p>Select something in the note.</p><p data-sel style="color: var(--ink-2)"></p>';
      const out = root.querySelector('[data-sel]');
      out.textContent = selected;
      // Needs the "events" permission to hear about selection changes; ask for it in manifest.json.
      inkwright.events.on('selection.changed', (e) => { out.textContent = e.text; });
    },
  },
};
