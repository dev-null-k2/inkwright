/**
 * The first run: four short, skippable steps — how you write, how it looks, where AI runs, how
 * notes sync — then the library, with sample notebooks if wanted. Every choice is an ordinary
 * setting, applied as it is made, and can be changed later in Settings. Finishing or skipping
 * marks it done for good on this device (settings.onboardingDone).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Cloud, FolderOpen, HardDrive, KeyRound, MonitorSmartphone, PenTool, Pointer, Server, Sparkles, X } from 'lucide-react';
import { useApp } from '../state/app.ts';
import { settingsWereStored, useSettings } from '../state/settings.ts';
import { cx, Segmented, Switch } from '../ui/primitives.tsx';
import { BrandMark } from '../ui/Brand.tsx';
import { PalettePicker } from '../ui/PalettePicker.tsx';
import { LocalAISetup } from '../ui/LocalAISetup.tsx';
import { GoogleSetupDialog } from '../ui/GoogleSetupDialog.tsx';
import { AddProvider } from '../screens/Settings.tsx';
import { useLocalAI } from '../lib/localai.ts';
import { signIn } from '../lib/google.ts';
import { chooseSyncFolder, folderSyncSupported, resetSyncEngines, syncNow } from '../lib/sync.ts';
import { applyPlan, isModuleOn, planToggle, useModule } from '../modules/registry.ts';
import { STARTER_TAG, WELCOME_STEPS, assistantPreferenceFor, fingerActionFor, welcomeDecision, writingToolFrom, type AIChoice, type WelcomeStep, type WritingTool } from './welcome.ts';

/** Mounted once by the app: shows the welcome on a first run, otherwise nothing. */
export function WelcomeGate() {
  const done = useSettings((s) => s.onboardingDone);
  const ownNotes = useApp((s) => s.notes.filter((n) => !n.tags.includes(STARTER_TAG)).length);
  const route = useApp((s) => s.route.name);
  // Decided once, when the library first loads: notes arriving later (sync) don't close it.
  const [decision] = useState(() => welcomeDecision({ onboardingDone: done, settingsStored: settingsWereStored, ownNotes }));
  useEffect(() => { if (decision === 'mark-done') useSettings.getState().update(() => ({ onboardingDone: true })); }, [decision]);
  // Links straight into a note or Settings are honoured; the welcome waits for the library.
  if (decision !== 'show' || done || route !== 'library') return null;
  return <Welcome />;
}

const TITLES: Record<WelcomeStep, string> = {
  writing: 'How do you write?',
  look: 'Choose your colours',
  ai: 'Where should AI run?',
  sync: 'Keep your notes in sync',
};

function Welcome() {
  const s = useSettings();
  const { vault, navigate, toast } = useApp();
  const themesOn = useModule('themes');
  const [step, setStep] = useState(0);
  const [ai, setAI] = useState<AIChoice>('device');
  const [samples, setSamples] = useState(true);
  const [googleHelp, setGoogleHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const id = WELCOME_STEPS[step]!;
  const last = step === WELCOME_STEPS.length - 1;

  // Each step starts with its question, for screen readers and keyboards alike.
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, [step]);

  const close = () => s.update(() => ({ onboardingDone: true }));

  /** Applies the choices that only take effect at the end, then leaves (to `then`, or the library). */
  const finish = async (then?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      const pref = assistantPreferenceFor(ai);
      if (pref) useLocalAI.getState().setPrefs({ assistant: pref });
      if (ai === 'none' && isModuleOn('assistant')) applyPlan(planToggle('assistant', false));
      if (samples && vault) {
        const { seedSampleLibrary } = await import('../lib/sample.ts');
        const before = new Set((await vault.listNotes(true)).map((n) => n.id));
        await seedSampleLibrary(vault.vault);
        for (const n of await vault.listNotes()) if (!before.has(n.id)) vault.indexNote(n, await vault.vault.readPages(n));
        await useApp.getState().refresh();
      }
    } catch (e) {
      toast({ text: `Couldn’t add the sample notebooks: ${(e as Error).message}`, tone: 'error' });
    } finally {
      close();
      then?.();
    }
  };

  const tool = writingToolFrom(s.input.fingerAction);
  const setTool = (t: WritingTool) => s.update((x) => ({ input: { ...x.input, fingerAction: fingerActionFor(t) } }));

  const googleSignIn = async () => {
    if (!s.sync.googleClientId) return setGoogleHelp(true);
    try {
      const a = await signIn();
      s.update((x) => ({ sync: { ...x.sync, drive: { ...x.sync.drive, enabled: true } } }));
      resetSyncEngines();
      void syncNow();
      toast({ text: `Signed in as ${a.email}. Your notes will sync with Google Drive.`, tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  const chooseFolder = async () => {
    try {
      const name = await chooseSyncFolder();
      if (name) { toast({ text: `Your notes will also be kept in “${name}”.`, tone: 'success' }); void syncNow(); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ text: (e as Error).message, tone: 'error' });
    }
  };

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" onKeyDown={(e) => { if (e.key === 'Escape' && !googleHelp) close(); }}>
      <div className="welcome-card">
        <header className="welcome-head">
          {step > 0
            ? <button type="button" className="icon-btn" aria-label="Back" onClick={() => setStep(step - 1)}><ArrowLeft size={19} /></button>
            : <BrandMark size={30} />}
          <ol className="welcome-dots" aria-label={`Step ${step + 1} of ${WELCOME_STEPS.length}`}>
            {WELCOME_STEPS.map((x, i) => <li key={x} className={cx(i === step && 'is-on', i < step && 'is-done')} aria-hidden />)}
          </ol>
          <button type="button" className="btn btn-ghost btn-sm welcome-skip" onClick={close}>Skip</button>
        </header>

        <div className="welcome-body" key={id}>
          {step === 0 && <p className="welcome-kicker">Welcome to Inkwright</p>}
          <h1 id="welcome-title" ref={title} tabIndex={-1}>{TITLES[id]}</h1>

          {id === 'writing' && (
            <>
              <div className="welcome-choices" role="radiogroup" aria-label="How do you write?">
                <Choice on={tool === 'pen'} onPick={() => setTool('pen')} icon={<PenTool size={20} />} title="With a pen" hint="The pen writes. Your finger scrolls and zooms, and a resting palm is ignored." />
                <Choice on={tool === 'finger'} onPick={() => setTool('finger')} icon={<Pointer size={20} />} title="With my finger" hint="Your finger writes. Two fingers scroll and zoom." />
              </div>
              <div className="welcome-row">
                <span className="row-label">Writing hand</span>
                <Segmented label="Writing hand" value={s.hand} onChange={(v) => s.update(() => ({ hand: v }))} options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }]} />
              </div>
              <p className="welcome-note">On wide screens the tool tray sits on the side away from your writing hand.</p>
            </>
          )}

          {id === 'look' && (
            <>
              {themesOn && <PalettePicker value={s.palette ?? 'duan'} onChange={(v) => s.update(() => ({ palette: v }))} />}
              <div className="welcome-row">
                <span className="row-label">Light or dark</span>
                <Segmented label="Light or dark" value={s.theme} onChange={(v) => s.update(() => ({ theme: v }))} options={[{ value: 'system', label: 'Match device' }, { value: 'light', label: 'Day' }, { value: 'dark', label: 'Night' }]} />
              </div>
            </>
          )}

          {id === 'ai' && (
            <>
              <div className="welcome-choices" role="radiogroup" aria-label="Where should AI run?">
                <Choice on={ai === 'device'} onPick={() => setAI('device')} icon={<HardDrive size={20} />} title="On this device" hint="Private and works offline. Nothing you write leaves the device." />
                <Choice on={ai === 'key'} onPick={() => setAI('key')} icon={<KeyRound size={20} />} title="With my own key" hint="Gemini, Claude, OpenAI and others. Requests go straight to them." />
                <Choice on={ai === 'none'} onPick={() => setAI('none')} icon={<X size={20} />} title="No AI" hint="Just paper and pen. You can switch AI on later in Settings." />
              </div>
              {ai === 'device' && <div className="welcome-detail"><LocalAISetup compact /></div>}
              {ai === 'key' && <div className="welcome-detail">{s.ai.providers.length ? <p className="welcome-note"><Sparkles size={14} /> {s.ai.providers.map((p) => p.label).join(', ')} added.</p> : <AddProvider onDone={() => {}} />}</div>}
            </>
          )}

          {id === 'sync' && (
            <>
              <p className="welcome-lede">Your notes are saved on this device. Add a copy elsewhere now, or later in Settings.</p>
              <div className="welcome-list">
                <SyncRow icon={<Cloud size={18} />} title="Google Drive" hint={s.sync.account ? `Signed in as ${s.sync.account.email}` : 'A visible Inkwright folder in your Drive'} onClick={() => void googleSignIn()} />
                <SyncRow icon={<Server size={18} />} title="WebDAV" hint="Nextcloud, Synology, ownCloud…" onClick={() => void finish(() => navigate({ name: 'settings', section: 'sync' }))} />
                {folderSyncSupported && <SyncRow icon={<FolderOpen size={18} />} title="A folder on this computer" hint="iCloud Drive, Dropbox or your Obsidian vault" onClick={() => void chooseFolder()} />}
                <SyncRow icon={<MonitorSmartphone size={18} />} title="Pair with another device" hint="Phone and computer sync directly, encrypted" onClick={() => void finish(() => navigate({ name: 'settings', section: 'devices' }))} />
              </div>
              <div className="welcome-samples">
                <Switch label="Start with sample notebooks" hint="A lecture, a meeting and a journal page to try things on. Delete them any time." checked={samples} onChange={setSamples} />
              </div>
              <GoogleSetupDialog open={googleHelp} onClose={() => setGoogleHelp(false)} clientId={s.sync.googleClientId}
                onClientId={(v) => { s.update((x) => ({ sync: { ...x.sync, googleClientId: v } })); resetSyncEngines(); }}
                onSignIn={() => { setGoogleHelp(false); void googleSignIn(); }} />
            </>
          )}
        </div>

        <footer className="welcome-actions">
          {last && isModuleOn('fill-sign') && (
            <button type="button" className="btn btn-ghost welcome-sign" disabled={busy} onClick={() => void finish(() => void import('../fill/signFlow.ts').then((m) => m.startSigning()))}>Sign a document</button>
          )}
          {last
            ? <button type="button" className="btn btn-primary welcome-next" disabled={busy} onClick={() => void finish()}>{busy ? 'Getting ready…' : 'Start writing'}</button>
            : <button type="button" className="btn btn-primary welcome-next" onClick={() => setStep(step + 1)}>Next</button>}
        </footer>
      </div>
    </div>
  );
}

function Choice({ on, onPick, icon, title, hint }: { on: boolean; onPick: () => void; icon: ReactNode; title: string; hint: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={cx('welcome-choice', on && 'is-on')} onClick={onPick}>
      <span className="welcome-choice-icon" aria-hidden>{icon}</span>
      <span className="welcome-choice-text"><span className="welcome-choice-title">{title}</span><span className="welcome-choice-hint">{hint}</span></span>
    </button>
  );
}

function SyncRow({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" className="welcome-sync" onClick={onClick}>
      <span className="welcome-choice-icon" aria-hidden>{icon}</span>
      <span className="welcome-choice-text"><span className="welcome-choice-title">{title}</span><span className="welcome-choice-hint">{hint}</span></span>
    </button>
  );
}
