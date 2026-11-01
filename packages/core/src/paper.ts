import { rect, rectIntersection, rectIsEmpty, type Rect } from './geometry.ts';
import { PAPER_TINTS, effectiveSpacing, type PaperSpec, type PaperTint } from './model.ts';

/**
 * Geometry of paper templates, shared by the screen renderer and every exporter so a page looks
 * the same everywhere. All values in page units (96 per inch).
 */
export type LineRole = 'rule' | 'margin' | 'grid' | 'grid-major' | 'dot' | 'staff' | 'section' | 'label';

export type TemplateElement =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; role: LineRole; width: number }
  | { kind: 'dot'; x: number; y: number; radius: number; role: LineRole }
  | { kind: 'text'; x: number; y: number; text: string; size: number; role: LineRole }
  | { kind: 'box'; x: number; y: number; w: number; h: number; role: LineRole; width: number };

export const TOP_MARGIN = 96;
export const LEFT_MARGIN = 120;
export const CORNELL_CUE_WIDTH = 240;
export const CORNELL_SUMMARY_HEIGHT = 192;
const MAX_ELEMENTS = 20000;

const snapUp = (v: number, step: number, origin: number) => origin + Math.ceil((v - origin) / step) * step;
const snapDown = (v: number, step: number, origin: number) => origin + Math.floor((v - origin) / step) * step;
const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Template elements visible in `region`. For a fixed page pass its bounds as `page`; for an
 * infinite board pass null and the pattern repeats over the region.
 */
export function paperElements(spec: PaperSpec, region: Rect, page: Rect | null): TemplateElement[] {
  if (spec.style === 'blank' || rectIsEmpty(region)) return [];
  const area = page ? rectIntersection(region, page) : region;
  if (rectIsEmpty(area)) return [];
  const s = Math.max(2, effectiveSpacing(spec));
  const out: TemplateElement[] = [];
  const top = page ? page.minY + TOP_MARGIN : -Infinity;
  const bottom = page ? page.maxY : Infinity;
  const line = (x1: number, y1: number, x2: number, y2: number, role: LineRole, width: number) =>
    out.push({ kind: 'line', x1, y1, x2, y2, role, width });

  const rules = (from: number, to: number, role: LineRole, origin: number, step = s) => {
    let y = snapUp(Math.max(area.minY, from), step, origin);
    const end = Math.min(area.maxY, to);
    while (y <= end && out.length < MAX_ELEMENTS) {
      line(area.minX, y, area.maxX, y, role, role === 'grid' ? 0.6 : 0.9);
      y += step;
    }
  };
  const columns = (step: number, role: LineRole, width: number, origin: number) => {
    let x = snapUp(area.minX, step, origin);
    while (x <= area.maxX && out.length < MAX_ELEMENTS) {
      line(x, area.minY, x, area.maxY, role, width);
      x += step;
    }
  };

  switch (spec.style) {
    case 'ruled_narrow':
    case 'ruled_wide': {
      rules(top, bottom, 'rule', Number.isFinite(top) ? top : 0);
      if (page) {
        const mx = page.minX + LEFT_MARGIN;
        if (inRange(mx, area.minX, area.maxX)) line(mx, area.minY, mx, area.maxY, 'margin', 1.2);
      }
      break;
    }
    case 'todo': {
      rules(top, bottom, 'rule', Number.isFinite(top) ? top : 0);
      // A checkbox at the start of every line.
      let y = snapUp(Math.max(area.minY, top), s, Number.isFinite(top) ? top : 0) + s;
      const x = (page?.minX ?? snapDown(area.minX, 400, 0)) + 48;
      while (y <= Math.min(area.maxY + s, bottom) && out.length < MAX_ELEMENTS) {
        const box = s * 0.5;
        if (inRange(x, area.minX - box, area.maxX)) out.push({ kind: 'box', x, y: y - s * 0.75, w: box, h: box, role: 'section', width: 1.1 });
        y += s;
      }
      break;
    }
    case 'cornell': {
      const summaryTop = page ? page.maxY - CORNELL_SUMMARY_HEIGHT : Infinity;
      rules(top, summaryTop, 'rule', Number.isFinite(top) ? top : 0);
      if (page) {
        const cx = page.minX + CORNELL_CUE_WIDTH;
        const cueBottom = Math.min(summaryTop, area.maxY);
        if (inRange(cx, area.minX, area.maxX) && area.minY < cueBottom) line(cx, Math.max(area.minY, page.minY + TOP_MARGIN * 0.6), cx, cueBottom, 'section', 1.4);
        if (inRange(summaryTop, area.minY, area.maxY)) line(area.minX, summaryTop, area.maxX, summaryTop, 'section', 1.4);
        const hy = page.minY + TOP_MARGIN * 0.6;
        if (inRange(hy, area.minY, area.maxY)) line(area.minX, hy, area.maxX, hy, 'section', 1.4);
        out.push({ kind: 'text', x: page.minX + 16, y: page.minY + TOP_MARGIN * 0.6 + 18, text: 'CUES', size: 10, role: 'label' });
        out.push({ kind: 'text', x: cx + 16, y: page.minY + TOP_MARGIN * 0.6 + 18, text: 'NOTES', size: 10, role: 'label' });
        if (Number.isFinite(summaryTop)) out.push({ kind: 'text', x: page.minX + 16, y: summaryTop + 18, text: 'SUMMARY', size: 10, role: 'label' });
      }
      break;
    }
    case 'square_grid': {
      rules(-Infinity, Infinity, 'grid', page?.minY ?? 0);
      columns(s, 'grid', 0.6, page?.minX ?? 0);
      break;
    }
    case 'graph_mm': {
      // 1 mm minor grid with a stronger line every 10 mm.
      const major = s * 10;
      let y = snapUp(area.minY, s, page?.minY ?? 0);
      let i = Math.round((y - (page?.minY ?? 0)) / s);
      while (y <= area.maxY && out.length < MAX_ELEMENTS) {
        line(area.minX, y, area.maxX, y, i % 10 === 0 ? 'grid-major' : 'grid', i % 10 === 0 ? 0.8 : 0.35);
        y += s; i++;
      }
      let x = snapUp(area.minX, s, page?.minX ?? 0);
      let j = Math.round((x - (page?.minX ?? 0)) / s);
      while (x <= area.maxX && out.length < MAX_ELEMENTS) {
        line(x, area.minY, x, area.maxY, j % 10 === 0 ? 'grid-major' : 'grid', j % 10 === 0 ? 0.8 : 0.35);
        x += s; j++;
      }
      void major;
      break;
    }
    case 'isometric': {
      // Horizontal-free triangle grid: two families of 30° lines plus verticals.
      const ox = page?.minX ?? 0, oy = page?.minY ?? 0;
      const dx = s * Math.sqrt(3);
      columns(dx / 2, 'grid', 0.5, ox);
      const tan = Math.tan(Math.PI / 6);
      const h = area.maxY - area.minY;
      for (const sign of [1, -1]) {
        // Lines y = sign*tan*x + c, spaced s vertically.
        const cAt = (x: number, y: number) => y - sign * tan * x;
        const c0 = Math.min(cAt(area.minX, area.minY), cAt(area.maxX, area.minY));
        const c1 = Math.max(cAt(area.minX, area.maxY), cAt(area.maxX, area.maxY));
        let c = snapUp(c0, s, cAt(ox, oy));
        while (c <= c1 && out.length < MAX_ELEMENTS) {
          line(area.minX, sign * tan * area.minX + c, area.maxX, sign * tan * area.maxX + c, 'grid', 0.5);
          c += s;
        }
      }
      void h;
      break;
    }
    case 'dot_grid': {
      let y = snapUp(area.minY, s, page?.minY ?? 0);
      while (y <= area.maxY && out.length < MAX_ELEMENTS) {
        let x = snapUp(area.minX, s, page?.minX ?? 0);
        while (x <= area.maxX && out.length < MAX_ELEMENTS) {
          out.push({ kind: 'dot', x, y, radius: 1.1, role: 'dot' });
          x += s;
        }
        y += s;
      }
      break;
    }
    case 'music': {
      const staffHeight = s * 4;
      const period = staffHeight + s * 7;
      const origin = page ? page.minY + TOP_MARGIN : 0;
      let y0 = snapDown(area.minY - staffHeight, period, origin);
      while (y0 <= area.maxY && out.length < MAX_ELEMENTS) {
        if (y0 >= top - 0.5 && y0 + staffHeight <= bottom) {
          for (let k = 0; k <= 4; k++) {
            const y = y0 + k * s;
            if (inRange(y, area.minY, area.maxY)) line(area.minX, y, area.maxX, y, 'staff', 0.8);
          }
        }
        y0 += period;
      }
      break;
    }
    case 'planner_day': {
      if (!page) { rules(-Infinity, Infinity, 'rule', 0); break; }
      const hy = page.minY + TOP_MARGIN * 0.7;
      line(page.minX + 40, hy, page.maxX - 40, hy, 'section', 1.4);
      out.push({ kind: 'text', x: page.minX + 40, y: page.minY + 40, text: 'DATE', size: 10, role: 'label' });
      // Hours 7:00–21:00 on the left two thirds, priorities + notes on the right.
      const colX = page.minX + (page.maxX - page.minX) * 0.62;
      line(colX, hy, colX, page.maxY - 40, 'section', 1.1);
      const slots = 15;
      const slotH = (page.maxY - 40 - (hy + 24)) / slots;
      for (let k = 0; k < slots; k++) {
        const y = hy + 24 + k * slotH;
        line(page.minX + 40, y, colX - 12, y, 'rule', 0.8);
        out.push({ kind: 'text', x: page.minX + 44, y: y + 14, text: `${7 + k}:00`, size: 9, role: 'label' });
      }
      out.push({ kind: 'text', x: colX + 16, y: hy + 22, text: 'TOP 3', size: 10, role: 'label' });
      for (let k = 0; k < 3; k++) out.push({ kind: 'box', x: colX + 16, y: hy + 40 + k * 34, w: 13, h: 13, role: 'section', width: 1.1 });
      out.push({ kind: 'text', x: colX + 16, y: hy + 160, text: 'NOTES', size: 10, role: 'label' });
      let y = hy + 196;
      while (y < page.maxY - 40) { line(colX + 16, y, page.maxX - 40, y, 'rule', 0.8); y += s; }
      break;
    }
    case 'planner_week': {
      if (!page) { rules(-Infinity, Infinity, 'rule', 0); break; }
      const hy = page.minY + TOP_MARGIN * 0.7;
      out.push({ kind: 'text', x: page.minX + 40, y: page.minY + 40, text: 'WEEK OF', size: 10, role: 'label' });
      const rows = 4;
      const cellH = (page.maxY - 40 - hy) / rows;
      const midX = (page.minX + page.maxX) / 2;
      for (let r = 0; r <= rows; r++) line(page.minX + 40, hy + r * cellH, page.maxX - 40, hy + r * cellH, 'section', 1.2);
      line(midX, hy, midX, page.maxY - 40, 'section', 1.2);
      for (let k = 0; k < 8; k++) {
        const r = Math.floor(k / 2), c = k % 2;
        const label = k < 7 ? DAYS[k]!.toUpperCase() : 'NOTES';
        out.push({ kind: 'text', x: (c === 0 ? page.minX + 48 : midX + 8), y: hy + r * cellH + 18, text: label, size: 9, role: 'label' });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** CSS color for a template role on a tint. */
export function paperRoleColor(role: LineRole, tint: PaperTint): string {
  const dark = PAPER_TINTS[tint]?.dark ?? false;
  if (dark) {
    switch (role) {
      case 'margin': return 'rgba(224,122,122,0.42)';
      case 'section': case 'dot': case 'label': return 'rgba(160,174,192,0.55)';
      case 'grid-major': return 'rgba(160,174,192,0.45)';
      default: return 'rgba(160,174,192,0.3)';
    }
  }
  switch (role) {
    case 'margin': return 'rgba(217,83,79,0.5)';
    case 'section': return 'rgba(103,128,156,0.6)';
    case 'label': return 'rgba(103,128,156,0.75)';
    case 'dot': return 'rgba(125,138,153,0.55)';
    case 'staff': return 'rgba(108,116,128,0.6)';
    case 'grid-major': return 'rgba(122,156,198,0.55)';
    default: return 'rgba(122,156,198,0.35)';
  }
}

/** Default ink color (`#AARRGGBB`) that reads well on a tint. */
export function defaultInkFor(tint: PaperTint): string {
  return PAPER_TINTS[tint]?.dark ? '#FFF2F2F2' : '#FF1B1F24';
}

export function pageRect(width: number, height: number): Rect {
  return rect(0, 0, width, height);
}
