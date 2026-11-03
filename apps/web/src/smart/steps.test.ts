import { describe, expect, it } from 'vitest';
import { parseMath } from '@inkwright/core';
import { expandPercent, solveMath } from './math.ts';
import { Q, equationSteps, exactArithmetic, polyOf, showPoly, systemSteps } from './steps.ts';

describe('exact rationals', () => {
  it('reduces, adds and divides exactly', () => {
    expect(new Q(6n, -8n).toString()).toBe('-3/4');
    expect(Q.of(0.1)!.add(Q.of(0.2)!).toString()).toBe('3/10');
    expect(new Q(1n, 3n).div(new Q(2n)).toString()).toBe('1/6');
    expect(new Q(9n, 4n).sqrt()!.toString()).toBe('3/2');
    expect(new Q(2n).sqrt()).toBeNull();
    expect(() => new Q(1n, 0n)).toThrow();
  });
});

describe('arithmetic with steps', () => {
  it('follows the order of operations', () => {
    const r = exactArithmetic(parseMath('2+3*4-1'))!;
    expect(r.value.toString()).toBe('13');
    expect(r.steps[0]).toBe('Multiply: 3 × 4 = 12 → 2 + 12 − 1');
    expect(r.steps.at(-1)).toBe('Subtract: 14 − 1 = 13');
  });
  it('shows the common denominator for fractions', () => {
    const r = exactArithmetic(parseMath('1/2+1/3'))!;
    expect(r.value.toString()).toBe('5/6');
    expect(r.steps.some((s) => s.startsWith('Common denominator 6: 3/6 + 2/6 = 5/6'))).toBe(true);
  });
  it('declines what is not exact rational arithmetic', () => {
    expect(exactArithmetic(parseMath('sqrt(2)+1'))).toBeNull();
    expect(exactArithmetic(parseMath('x+1'))).toBeNull();
    expect(exactArithmetic(parseMath('sqrt(16)+2'))!.value.toString()).toBe('6');
  });
});

describe('equations with steps', () => {
  it('solves linear equations the way it is done by hand', () => {
    const r = equationSteps(parseMath('5x-2'), parseMath('3x+6'), 'x')!;
    expect(r.solutions!.map(String)).toEqual(['4']);
    expect(r.steps).toEqual(['Expand both sides: 5x − 2 = 3x + 6', 'Collect x on the left, numbers on the right: 2x = 8', 'Divide both sides by 2: x = 4']);
  });
  it('solves quadratics through the discriminant, factored when it can', () => {
    const r = equationSteps(parseMath('x^2-5x+6'), parseMath('0'), 'x')!;
    expect(r.solutions!.map(String)).toEqual(['2', '3']);
    expect(r.steps).toContain('Discriminant: b² − 4ac = 1');
    expect(r.steps).toContain('Factored: (x − 2)(x − 3) = 0');
    expect(equationSteps(parseMath('x^2+1'), parseMath('0'), 'x')!.solutions).toEqual([]);
    expect(equationSteps(parseMath('x^2'), parseMath('2'), 'x')!.solutions).toBeNull();
  });
  it('reads polynomials with brackets and fractions', () => {
    expect(showPoly(polyOf(parseMath('3(x+1)-x/2'), 'x')!, 'x')).toBe('(5/2)x + 3');
    expect(polyOf(parseMath('x^3'), 'x')).toBeNull();
  });
  it('eliminates in a 2 × 2 system', () => {
    const r = systemSteps([[parseMath('2x+3y'), parseMath('12')], [parseMath('x-y'), parseMath('1')]], ['x', 'y'])!;
    expect(r.solution!.map(String)).toEqual(['3', '2']);
    expect(r.steps.at(-1)).toBe('Put x = 3 back into an equation: y = 2');
    expect(systemSteps([[parseMath('x+y'), parseMath('1')], [parseMath('2x+2y'), parseMath('5')]], ['x', 'y'])!.solution).toBeNull();
  });
});

describe('the solver uses them', () => {
  it('answers exactly, with steps', async () => {
    const f = await solveMath('3/4 × 2/5 =');
    expect(f.result).toBe('= 3/10 = 0.3');
    const d = await solveMath('3.5 + 1.25 =');
    expect(d.result).toBe('= 4.75');
    const e = await solveMath('7x-12 = 3x+8');
    expect(e.result).toBe('x = 5');
    expect(e.steps?.length).toBeGreaterThan(1);
    const s = await solveMath('x+y=10\nx-y=4');
    expect(s.result).toBe('x = 7, y = 3');
    expect(s.steps?.[0]).toContain('a·x + b·y = c');
    expect((await solveMath('1/3')).result).toBe('= 1/3 ≈ 0.3333');
  });
  it('understands percentages', async () => {
    expect(expandPercent('20% of 50')).toBe('(20/100)*50');
    expect((await solveMath('20% of 50 =')).result).toBe('= 10');
    expect((await solveMath('15%')).result).toBe('= 0.15');
  });
});
