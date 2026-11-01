import { VaultLayout, exportPageSvg, type NoteMeta, type PageInk } from '@inkstone/core';
import type { ServerContext } from './context.ts';

/** Rasterizes an SVG document to PNG at the given pixel width. */
export type PngRenderer = (svg: string, width: number) => Promise<Uint8Array | null>;

interface ResvgModule {
  Resvg: new (svg: string, opts?: Record<string, unknown>) => { render(): { asPng(): Uint8Array } };
}

/**
 * Loads @resvg/resvg-js (an optional dependency with native binaries). Returns null when it is not
 * installed for this platform, in which case tools fall back to SVG.
 */
export async function loadResvgRenderer(): Promise<PngRenderer | null> {
  let mod: ResvgModule;
  try {
    // A non-literal specifier keeps bundlers and the type checker from requiring the package.
    const spec = '@resvg/resvg-js';
    const m = (await import(spec)) as Partial<ResvgModule> & { default?: Partial<ResvgModule> };
    const Resvg = m.Resvg ?? m.default?.Resvg;
    if (typeof Resvg !== 'function') return null;
    mod = { Resvg };
  } catch {
    return null;
  }
  return async (svg, width) => {
    const r = new mod.Resvg(svg, {
      fitTo: { mode: 'width', value: Math.round(width) },
      font: { loadSystemFonts: true },
    });
    return new Uint8Array(r.render().asPng());
  };
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const MAX_EMBED_BYTES = 8 * 1024 * 1024;

/** Asset file names a page's SVG refers to (images and background previews). */
function referencedAssets(page: PageInk): string[] {
  const names = new Set<string>();
  for (const im of page.images ?? []) names.add(im.asset);
  if (page.background) {
    names.add(page.background.kind === 'pdf' ? `${page.background.asset}.p${page.background.pageNumber ?? 1}.png` : page.background.asset);
  }
  return [...names];
}

/**
 * SVG of a page. With `embedAssets`, images are inlined as data URLs so a rasterizer (or a
 * client without vault access) sees them; otherwise hrefs stay relative to the page file
 * (`../assets/<name>`), matching the `.svg` files in the vault.
 */
export async function pageSvg(ctx: ServerContext, note: NoteMeta, page: PageInk, opts: { embedAssets?: boolean } = {}): Promise<string> {
  if (!opts.embedAssets) return exportPageSvg(note, page);
  const inline = new Map<string, string>();
  for (const name of referencedAssets(page)) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = MIME[ext];
    if (!mime) continue;
    const bytes = await ctx.vault.readAsset(note.id, name).catch(() => null);
    if (!bytes || bytes.length > MAX_EMBED_BYTES) continue;
    inline.set(name, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
  }
  return exportPageSvg(note, page, { assetHref: (name) => inline.get(name) ?? `../assets/${name}` });
}

/** Vault-relative path of a page's SVG file (for messages to the agent). */
export const pageSvgPath = (noteId: string, pageId: string) => VaultLayout.pageSvg(noteId, pageId);
