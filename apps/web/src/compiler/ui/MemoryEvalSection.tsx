/**
 * Settings › AI › "Does my memory help?": runs held-out questions from your own notes with and
 * without retrieval (and the compiled wiki), and reports accuracy, citation correctness and
 * tokens — including, plainly, when there is no significant difference.
 */
import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Square } from 'lucide-react';
import type { EvalCondition, MemoryEvalReport } from '@inkwright/ai';
import { relativeTime } from '../../ui/primitives.tsx';
import { useApp } from '../../state/app.ts';
import { lastMemoryEval, runMemoryEvalNow } from '../memeval.ts';
import { useCompiler } from '../service.ts';

const NAME: Record<EvalCondition, string> = { none: 'Model alone', notes: 'With your notes', wiki: 'With notes and compiled wiki' };
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function MemoryEvalSection() {
  const ready = useCompiler((s) => s.ready);
  const toast = useApp((s) => s.toast);
  const [report, setReport] = useState<MemoryEvalReport | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [n, setN] = useState(20);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { if (ready) void lastMemoryEval().then(setReport).catch(() => {}); }, [ready]);
  const run = async () => {
    abort.current = new AbortController();
    setProgress([0, 1]);
    try {
      setReport(await runMemoryEvalNow({ questions: n, signal: abort.current.signal, onProgress: (d, t) => setProgress([d, t]) }));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ text: (e as Error).message, tone: 'error' });
    } finally { setProgress(null); abort.current = null; }
  };
  return (
    <section className="set-group cp-memeval">
      <h2>Does my memory help?</h2>
      <div className="set-card">
        <p className="ag-lead">Asks your AI questions whose answers are in your notes — once on its own, once with what search finds in your notes, and once with the compiled wiki too — then checks the answers, the citations and the tokens used. It uses your AI and its tokens; questions are made from numbers, dates and definitions in your notes.</p>
        <div className="cp-compile">
          <label className="field-row"><span className="row-label">Questions</span>
            <select value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Number of questions"><option value={10}>10</option><option value={20}>20</option><option value={40}>40</option></select>
          </label>
          {progress ? (
            <><span className="muted small">Running {progress[0]} of {progress[1]}…</span><button type="button" className="btn btn-sm" onClick={() => abort.current?.abort()}><Square size={13} /> Stop</button></>
          ) : <button type="button" className="btn" onClick={() => void run()}><FlaskConical size={15} /> Run the eval</button>}
        </div>
        {report && (
          <div className="cp-eval-report" aria-label="Memory eval results">
            <p className="cp-eval-headline">{report.headline}</p>
            <table className="cp-eval-table">
              <thead><tr><th>Condition</th><th>Correct</th><th>Right citations</th><th>Found the note</th><th>Tokens / question</th></tr></thead>
              <tbody>
                {report.summary.map((s) => (
                  <tr key={s.condition}><th scope="row">{NAME[s.condition]}</th><td>{pct(s.accuracy)}</td><td>{pct(s.citationAccuracy)}</td><td>{pct(s.retrievalHit)}</td><td>{s.tokensPerQuestion.toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
            <ul className="cp-eval-comparisons">{report.comparisons.map((c) => <li key={`${c.a}-${c.b}`}>{c.verdict}</li>)}</ul>
            <p className="ag-note">{report.questions.length} questions · {report.model} · prompt <code>{report.prompt}</code> · {relativeTime(report.at)}. Exact McNemar test on the questions where the conditions differ.</p>
          </div>
        )}
      </div>
    </section>
  );
}
