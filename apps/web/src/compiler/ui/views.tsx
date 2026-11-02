/** The compiler's assistant screens, listed in AGENT_VIEWS (ui/agent/shared.tsx). */
import { LedgerView } from './LedgerView.tsx';
import { PeopleView } from './PeopleView.tsx';
import { StudyView } from './StudyView.tsx';
import { WikiView } from './WikiView.tsx';

export type CompilerViewId = 'wiki' | 'conflicts' | 'study' | 'people';

export const isCompilerView = (v: string): v is CompilerViewId => v === 'wiki' || v === 'conflicts' || v === 'study' || v === 'people';

export function CompilerAgentView({ view }: { view: CompilerViewId }) {
  if (view === 'wiki') return <WikiView />;
  if (view === 'conflicts') return <LedgerView />;
  if (view === 'study') return <StudyView />;
  return <PeopleView />;
}
