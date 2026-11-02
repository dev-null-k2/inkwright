import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileOutput, PanelRight, Puzzle, X } from 'lucide-react';
import { IconButton, Menu, Popover } from '../ui/primitives.tsx';
import { useApp } from '../state/app.ts';
import { saveFile } from '../platform/files.ts';
import { useModule } from '../modules/registry.ts';
import { closePluginPanel, findPlugin, mountPanel, openPluginPanel, pluginCommands, pluginExporters, pluginPanels, runCommand, runExporter, usePlugins } from './host.ts';

interface MenuItem { label: string; icon?: ReactNode; onClick: () => void; hint?: string }

/**
 * What plugins add to the editor: a ••• › Plugins item (their commands and panels), Export ›
 * plugin exporters, and the side panel a plugin panel renders in. Nothing appears while the
 * Plugins module is off or no installed plugin contributes anything.
 */
export function useEditorPlugins({ noteId, anchor, onPanelOpen }: { noteId: string; anchor: HTMLElement | null; onPanelOpen: () => void }) {
  const on = useModule('plugins');
  usePlugins((s) => s.plugins); // re-render when plugins change
  const openPanel = usePlugins((s) => s.openPanel);
  const toast = useApp((a) => a.toast);
  const [menuOpen, setMenuOpen] = useState(false);
  const commands = on ? pluginCommands('editor') : [];
  const panels = on ? pluginPanels() : [];
  const exporters = on ? pluginExporters() : [];

  const menuItems: MenuItem[] = commands.length || panels.length ? [{ label: 'Plugins', icon: <Puzzle size={16} />, hint: `${commands.length + panels.length}`, onClick: () => setTimeout(() => setMenuOpen(true), 0) }] : [];

  const exportItems: MenuItem[] = exporters.map((x) => ({
    label: x.title,
    icon: <FileOutput size={16} />,
    hint: `.${x.extension} · ${x.pluginName}`,
    onClick: async () => {
      try {
        const out = await runExporter(x.pluginId, x.id, noteId);
        const base = (out.fileName ?? 'Note').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Note';
        await saveFile(base.endsWith(`.${out.extension}`) ? base : `${base}.${out.extension}`, new TextEncoder().encode(out.text), out.mimeType);
      } catch (e) {
        toast({ text: `${x.pluginName}: ${(e as Error).message}`, tone: 'error' });
      }
    },
  }));

  const popover = (
    <Popover anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} title="Plugins" placement="below">
      <Menu onClose={() => setMenuOpen(false)} items={[
        ...panels.map((p) => ({ label: p.title, icon: <PanelRight size={16} />, hint: p.pluginName, onClick: () => { onPanelOpen(); openPluginPanel(p.pluginId, p.id); } })),
        ...commands.map((c) => ({ label: c.title, icon: <Puzzle size={16} />, hint: c.pluginName, onClick: () => void runCommand(c.pluginId, c.id) })),
      ]} />
    </Popover>
  );

  const panel = on && openPanel ? <PluginSidePanel key={`${openPanel.pluginId}:${openPanel.panelId}`} pluginId={openPanel.pluginId} panelId={openPanel.panelId} /> : null;
  return { menuItems, exportItems, popover, panel, panelOpen: !!panel, closePanel: closePluginPanel };
}

/** A plugin panel: the plugin's own sandboxed frame inside the editor's side panel. */
function PluginSidePanel({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const p = findPlugin(pluginId);
  const title = p?.manifest?.contributes.panels?.find((x) => x.id === panelId)?.title ?? 'Plugin';
  useEffect(() => {
    if (!box.current) return;
    let dispose: (() => void) | null = null;
    let alive = true;
    mountPanel(pluginId, panelId, box.current, (px) => setHeight(px)).then((d) => { if (alive) dispose = d; else d(); }, (e) => setError((e as Error).message));
    return () => { alive = false; dispose?.(); };
  }, [pluginId, panelId]);
  return (
    <aside className="side-panel plg-panel" aria-label={title}>
      <header className="plg-panel-head">
        <h2>{title}</h2>
        <span className="muted small">{p?.manifest?.name}</span>
        <IconButton label="Close" onClick={closePluginPanel}><X size={18} /></IconButton>
      </header>
      {error && <p className="set-empty">{error}</p>}
      <div ref={box} className="plg-panel-body" style={{ ['--plg-h' as string]: `${height}px` }} />
    </aside>
  );
}
