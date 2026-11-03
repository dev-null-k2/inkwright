import { formatMath, normalizeMath, parseMath } from '@inkwright/core';

/** The same maths? Each side of each line parsed and printed canonically. */
export function sameMaths(a: string, b: string): boolean {
  const canon = (src: string) => src.split('\n').map((line) => normalizeMath(line).replace(/\s*=\s*$/, '').split('=').map((side) => {
    try { return formatMath(parseMath(side.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)'))); } catch { return `!${side}`; }
  }).join('=')).join('\n');
  return canon(a) === canon(b);
}
