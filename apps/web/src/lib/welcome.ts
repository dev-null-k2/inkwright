import { newId, type InkPoint, type InkStroke, type TextBox, type Vault } from '@inkstone/core';

function wave(x0: number, y: number, w: number, amp: number, id = newId()): InkStroke {
  const points: InkPoint[] = [];
  for (let i = 0; i <= 60; i++) {
    const f = i / 60;
    points.push({ x: x0 + f * w, y: y + Math.sin(f * Math.PI * 2) * amp, t: i * 9, p: 0.35 + 0.4 * Math.sin(f * Math.PI), tilt: -1, orient: -1 });
  }
  return { id, pen: 'fountain', color: '#FF1F3A93', size: 2.4, points, createdAt: Date.now() };
}

function underline(x0: number, y: number, w: number): InkStroke {
  const points: InkPoint[] = [];
  for (let i = 0; i <= 30; i++) points.push({ x: x0 + (w * i) / 30, y: y + Math.sin(i / 4) * 0.8, t: i * 8, p: 0.6, tilt: -1, orient: -1 });
  return { id: newId(), pen: 'highlighter', color: '#FFFFD54A', size: 18, points, createdAt: Date.now() };
}

const text = (x: number, y: number, width: number, body: string, size = 17, font: TextBox['font'] = 'sans'): TextBox => ({
  id: newId(), x, y, width, text: body, fontSize: size, color: '#FF1B1F24', font, createdAt: Date.now(),
});

/** First-run note that teaches the gestures by letting people try them on it. */
export async function seedWelcome(vault: Vault) {
  const { note, pages } = await vault.createNote({ title: 'Welcome to Inkstone', tags: ['start here'], paper: { style: 'dot_grid', tint: 'ivory', texture: 'standard', spacing: 0 } });
  const page = pages[0]!;
  const texts: TextBox[] = [
    text(64, 70, 640, '# Welcome to Inkstone', 18, 'serif'),
    text(64, 140, 640, 'Write anywhere on this page. Try each of these right here:', 17),
    text(64, 196, 650, [
      '- [ ] Scribble back and forth over a word to erase it',
      '- [ ] Draw a circle, box or line and keep the pen still for half a second to make it perfect',
      '- [ ] Press the pen button once to switch to the eraser, again to switch back. Hold it to erase only while held',
      '- [ ] Tap with two fingers to undo, three fingers to redo',
      '- [ ] Pinch to zoom; drag with one finger to scroll (fingers never ink while the pen is near)',
      '- [ ] Use the lasso to circle ink, then drag, resize, recolour or ask AI about it',
    ].join('\n'), 16),
    text(64, 520, 640, '## Your notes are yours', 16, 'serif'),
    text(64, 560, 640, 'Everything is saved as plain files (ink JSON, SVG and Markdown). Sync them with Google Drive, a folder or WebDAV, and let any AI agent read them through the Inkstone MCP server.', 16),
    text(64, 700, 640, '## Bring your own AI', 16, 'serif'),
    text(64, 740, 640, 'Add a key for OpenAI, Claude, Gemini, OpenRouter, a local model or any compatible endpoint in Settings. Then ask questions about your notes, turn handwriting into text, pull out to-dos or make flashcards.', 16),
  ];
  const strokes = [underline(60, 104, 330), wave(470, 470, 220, 10)];
  await vault.saveNote({ ...note, pinned: true }, [{ ...page, texts, strokes, recognizedText: '' }]);
}
