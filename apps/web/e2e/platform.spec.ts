import { expect, test } from '@playwright/test';
import { newNote, openApp, pen, strokes, word } from './helpers.ts';

/**
 * Keyboard shortcuts use the platform's modifier: ⌘ on Apple devices (the menus show ⌘), Ctrl
 * elsewhere. iPhones and iPads with a hardware keyboard (Magic Keyboard, Smart Keyboard) report
 * iOS user agents, which used to fall through to Ctrl.
 */
const shortcuts = [
  { device: 'iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', mod: 'Meta', other: 'Control' },
  { device: 'Mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', mod: 'Meta', other: 'Control' },
  { device: 'Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', mod: 'Control', other: 'Meta' },
] as const;

for (const s of shortcuts) {
  test.describe(`${s.device} keyboard`, () => {
    test.use({ userAgent: s.ua });

    test(`${s.mod}+Z undoes and ${s.other}+Z does not`, async ({ page }) => {
      await openApp(page);
      await newNote(page);
      await pen(page, word(200, 220, 160));
      await pen(page, word(200, 300, 160));
      await page.keyboard.press(`${s.other}+z`);
      expect(await strokes(page)).toHaveLength(2);
      await page.keyboard.press(`${s.mod}+z`);
      expect(await strokes(page)).toHaveLength(1);
      await page.keyboard.press(`${s.mod}+Shift+z`);
      expect(await strokes(page)).toHaveLength(2);
    });
  });
}
