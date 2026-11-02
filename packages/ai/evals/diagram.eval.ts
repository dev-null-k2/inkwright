/**
 * Verified diagrams: the create_diagram repair loop. A model emits typed IR, the deterministic
 * validator answers with a receipt, and the model repairs until the diagram is valid — or the tool
 * stops it. Scored offline with a scripted model that makes the mistakes real models make (an
 * unknown node id, a misspelt kind, a dependency cycle, an invented code symbol); live mode
 * (INKSTONE_EVAL_PROVIDER/_KEY/_MODEL) runs the same prompts and checks against a real model.
 *
 * The invariants: the loop converges when the model follows the receipt, and invalid IR never
 * lands on a page.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { validateDiagram, type CodeGraph, type DiagramIR } from '@inkstone/core';
import {
  createCodeTools, createDiagramTool, createScriptedProvider, runAgent, codeRefResolver,
  type AgentResult, type DevToolHost, type Provider, type ScriptStep, type ScriptedTurn,
} from '../src/index.ts';
import { liveConfig, printReport } from './harness.ts';

const live = liveConfig();

const GRAPH: CodeGraph = {
  formatVersion: 1, sourceId: 'shop', name: 'shop', scannedAt: 1, generator: 'test', files: [{ path: 'src/server.ts', language: 'typescript', hash: '', size: 1 }, { path: 'src/orders.ts', language: 'typescript', hash: '', size: 1 }],
  symbols: [
    { id: 'src/server.ts#POST /checkout', name: 'POST /checkout', qualified: 'POST /checkout', kind: 'route', file: 'src/server.ts', line: 3, endLine: 3, signature: 'POST /checkout', hash: 'a' },
    { id: 'src/orders.ts#saveOrder', name: 'saveOrder', qualified: 'saveOrder', kind: 'function', file: 'src/orders.ts', line: 1, endLine: 4, signature: 'function saveOrder(o: Order): Promise<void>', hash: 'b', exported: true },
  ],
  edges: [{ from: 'src/server.ts#POST /checkout', to: 'src/orders.ts#saveOrder', kind: 'calls' }],
};

class Host implements DevToolHost {
  placed: DiagramIR[] = [];
  constructor(private graphs: CodeGraph[] = [GRAPH]) {}
  async codeGraphs() { return this.graphs; }
  async placeDiagram(ir: DiagramIR) {
    this.placed.push(ir);
    return { noteId: 'n1', title: 'Architecture', pageIndex: 0, objectId: `d${this.placed.length}` };
  }
}

interface DiagramCase {
  id: string;
  prompt: string;
  script: ScriptStep[];
  maxAttempts?: number;
  /** What must hold afterwards. */
  expect: { placed: number; maxCalls?: number; minRejections?: number };
}

const call = (diagram: unknown): ScriptedTurn => ({ toolCalls: [{ name: 'create_diagram', arguments: { diagram } }] });
const base = {
  nodes: [{ id: 'web', label: 'Web', kind: 'client' }, { id: 'api', label: 'API', kind: 'service' }, { id: 'db', label: 'Orders DB', kind: 'database' }],
  edges: [{ from: 'web', to: 'api' }, { from: 'api', to: 'db', kind: 'data' }],
};

const CASES: DiagramCase[] = [
  {
    id: 'valid-first-time',
    prompt: 'Draw web → API → orders database.',
    script: [call(base), { text: 'Drew it.' }],
    expect: { placed: 1, maxCalls: 1 },
  },
  {
    id: 'repairs-unknown-ref-and-kind',
    prompt: 'Draw the checkout architecture.',
    script: [
      call({ ...base, nodes: [base.nodes[0], base.nodes[1], { id: 'db', label: 'Orders DB', kind: 'databse' }], edges: [...base.edges, { from: 'api', to: 'payments' }] }),
      // The scripted model reads the receipt's hints the way a model would.
      (ctx) => {
        const receipt = ctx.toolResults[0]!.text;
        if (!/Did you mean "database"/.test(receipt) || !/payments/.test(receipt)) return { text: 'I could not understand the error.' };
        return call({ ...base, nodes: [...base.nodes, { id: 'payments', label: 'Payments', kind: 'external' }], edges: [...base.edges, { from: 'api', to: 'payments' }] });
      },
      { text: 'Drew it after fixing two issues.' },
    ],
    expect: { placed: 1, maxCalls: 2, minRejections: 1 },
  },
  {
    id: 'repairs-dependency-cycle',
    prompt: 'Draw the module dependencies; they must be layered.',
    script: [
      call({ acyclic: true, nodes: [{ id: 'ui' }, { id: 'core' }, { id: 'store' }], edges: [{ from: 'ui', to: 'core' }, { from: 'core', to: 'store' }, { from: 'store', to: 'ui' }] }),
      (ctx) => (/Cycle: ui → core → store → ui/.test(ctx.toolResults[0]!.text)
        ? call({ acyclic: true, nodes: [{ id: 'ui' }, { id: 'core' }, { id: 'store' }], edges: [{ from: 'ui', to: 'core' }, { from: 'core', to: 'store' }] })
        : { text: '?' }),
      { text: 'Done.' },
    ],
    expect: { placed: 1, maxCalls: 2, minRejections: 1 },
  },
  {
    id: 'repairs-invented-code-ref',
    prompt: 'Draw the checkout flow and bind nodes to the code.',
    script: [
      call({ ...base, nodes: [base.nodes[0], { ...base.nodes[1], code: 'src/server.ts#checkout' }, base.nodes[2]] }),
      (ctx) => (/unbound_code_ref/.test(ctx.toolResults[0]!.text) ? { toolCalls: [{ name: 'code_search', arguments: { query: 'checkout', kind: 'route' } }] } : { text: '?' }),
      (ctx) => {
        const id = (ctx.toolResults[0]!.value as { results: { id: string }[] }).results[0]?.id;
        return call({ ...base, nodes: [base.nodes[0], { ...base.nodes[1], code: id }, base.nodes[2]] });
      },
      { text: 'Done.' },
    ],
    expect: { placed: 1, maxCalls: 2, minRejections: 1 },
  },
  {
    id: 'gives-up-without-landing-bad-ir',
    prompt: 'Draw it.',
    maxAttempts: 3,
    // A model that never listens: the same broken diagram, over and over.
    script: Array.from({ length: 6 }, () => call({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] })).concat([{ text: 'Sorry.' }]),
    expect: { placed: 0 },
  },
  {
    id: 'json-text-is-validated-too',
    prompt: 'Draw it.',
    script: [call('{"nodes": [{"id": "a"}], "edges": ['), call(JSON.stringify(base)), { text: 'ok' }],
    expect: { placed: 1, maxCalls: 2, minRejections: 1 },
  },
];

interface Outcome { id: string; mode: string; converged: boolean; placed: number; rejections: number; calls: number; allPlacedValid: boolean }

async function run(c: DiagramCase, provider?: Provider, model = 'scripted'): Promise<{ o: Outcome; result: AgentResult }> {
  const host = new Host();
  const tools = [createDiagramTool(host, { maxAttempts: c.maxAttempts ?? 4 }), ...createCodeTools(host)];
  const result = await runAgent({
    provider: provider ?? createScriptedProvider(c.script, { fallbackText: 'Done.' }),
    model,
    system: 'You draw architecture diagrams for the user with create_diagram. Fix every issue the tool reports and resend the whole diagram.',
    messages: [{ role: 'user', content: c.prompt }],
    tools,
    maxSteps: 10,
    temperature: 0,
  });
  const calls = result.toolRuns.filter((r) => r.call.name === 'create_diagram');
  const resolve = codeRefResolver([GRAPH]);
  const o: Outcome = {
    id: c.id,
    mode: provider ? 'live' : 'scripted',
    converged: host.placed.length === 1,
    placed: host.placed.length,
    rejections: calls.filter((r) => !r.ok).length,
    calls: calls.length,
    allPlacedValid: host.placed.every((ir) => validateDiagram(ir, { resolveCode: resolve }).ok),
  };
  return { o, result };
}

const report = (rows: Outcome[], title: string) => printReport([
  `\n${title}`,
  'case                               placed  calls  rejected  valid',
  ...rows.map((r) => `${r.id.padEnd(34)} ${String(r.placed).padStart(6)} ${String(r.calls).padStart(6)} ${String(r.rejections).padStart(9)}  ${r.allPlacedValid ? 'yes' : 'NO'}`),
].join('\n'));

describe('create_diagram repair loop — scripted model', () => {
  const rows: Outcome[] = [];
  afterAll(() => report(rows, 'Verified diagrams — scripted'));

  for (const c of CASES) {
    it(c.id, async () => {
      const { o, result } = await run(c);
      rows.push(o);
      expect(o.placed).toBe(c.expect.placed);
      expect(o.allPlacedValid).toBe(true);
      if (c.expect.maxCalls) expect(o.calls).toBeLessThanOrEqual(c.expect.maxCalls);
      if (c.expect.minRejections) expect(o.rejections).toBeGreaterThanOrEqual(c.expect.minRejections);
      if (c.id === 'gives-up-without-landing-bad-ir') {
        // Three receipts, then a refusal: the tool never accepts a fourth try.
        expect(o.rejections).toBeGreaterThanOrEqual(4);
        expect(result.toolRuns.filter((r) => r.call.name === 'create_diagram').at(-1)!.error).toMatch(/Stopped after 3 invalid diagrams/);
      }
    });
  }

  it('the receipt names every issue with a pointer the model can act on', async () => {
    const { result } = await run(CASES[1]!);
    const first = result.toolRuns.find((r) => r.call.name === 'create_diagram' && !r.ok)!;
    expect(first.error).toContain('[unknown_kind] /nodes/2/kind');
    expect(first.error).toContain('[unknown_node_ref] /edges/2/to');
    expect(first.error).toContain('Attempt 1 of 4; nothing was placed.');
  });
});

describe.skipIf(!live)('create_diagram repair loop — live model', () => {
  const rows: Outcome[] = [];
  afterAll(() => report(rows, `Verified diagrams — ${live?.label}`));
  for (const c of CASES.filter((x) => x.expect.placed === 1 && x.id !== 'json-text-is-validated-too')) {
    it(c.id, async () => {
      const { o } = await run(c, live!.provider, live!.model);
      rows.push(o);
      // A real model may need more or fewer tries; what must hold is that nothing invalid lands.
      expect(o.allPlacedValid).toBe(true);
      expect(o.placed).toBeLessThanOrEqual(1);
    });
  }
});
