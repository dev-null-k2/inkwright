// Send selection to a webhook — an example Inkwright plugin (docs/PLUGINS.md).
//
// Shows network access: the manifest asks for "network" with hosts ["*"] (any https site, because
// the user picks the URL), and every request goes through `inkwright.net.fetch`, which the host
// checks against that list. The sandbox itself cannot open connections.

/** @typedef {import('@inkwright/plugin-api').InkwrightAPI} InkwrightAPI */

/** The request body for each supported format. */
export function payload(format, { title, text, noteId, page, sentAt }) {
  if (format === 'slack') return { text: `*${title}* (p. ${page})\n${text}` };
  return { title, text, noteId, page, sentAt };
}

export default {
  /** @param {InkwrightAPI} inkwright */
  activate(inkwright) {
    inkwright.commands.register('send', async () => {
      const settings = await inkwright.settings.get();
      const url = String(settings.url || '').trim();
      if (!/^https:\/\//.test(url)) return inkwright.ui.toast('Set the webhook URL first: Settings › Plugins › Send selection to a webhook.', 'error');
      const open = await inkwright.editor.current();
      if (!open) return inkwright.ui.toast('Open a note and select something first.');
      const text = await inkwright.editor.selection();
      if (!text) return inkwright.ui.toast('Select some text or recognized handwriting first.');
      const body = JSON.stringify(payload(String(settings.format || 'json'), { title: open.title, text, noteId: open.noteId, page: open.page, sentAt: new Date().toISOString() }));
      const headers = { 'content-type': 'application/json' };
      if (settings.authorization) headers.authorization = String(settings.authorization);
      try {
        const res = await inkwright.net.fetch(url, { method: 'POST', headers, body });
        if (res.ok) await inkwright.ui.toast(`Sent to ${new URL(url).hostname}`, 'success');
        else await inkwright.ui.toast(`The webhook answered ${res.status}.`, 'error');
      } catch (e) {
        await inkwright.ui.toast(`Couldn’t send: ${e.message}`, 'error');
      }
    });
  },
};
