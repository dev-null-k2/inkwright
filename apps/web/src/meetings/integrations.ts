/**
 * Meeting notes and action items to the tools people use: chat (Slack, Teams, Discord), docs
 * (Notion), issues and tasks (Linear, Jira, GitHub, Todoist), CRMs (HubSpot, Attio) and any
 * webhook (Zapier, Make, n8n, your own). Nothing is sent without the person pressing Send on a
 * preview; tokens and webhook addresses are device secrets (lib/secrets.ts), never in the vault.
 *
 * Requests go through `integrationFetch`: the Android and iOS apps use native HTTP and the
 * desktop app its shell (apps/desktop integrations.rs), so APIs without CORS headers work there;
 * in a browser the services that allow it are called directly, Slack and webhooks are sent as
 * simple posts, and the rest say which app to use.
 */
import { CapacitorHttp } from '@capacitor/core';
import {
  meetingMarkdown,
  meetingNotionBlocks,
  meetingSlack,
  type MeetingHeader,
  type MeetingItem,
  type MeetingNotesVersion,
} from '@inkwright/core';
import { invoke, isDesktop } from '../desktop/bridge.ts';
import { getSecret, setSecret } from '../lib/secrets.ts';
import { isNative } from '../platform/env.ts';

export type IntegrationId = 'slack' | 'teams' | 'discord' | 'notion' | 'linear' | 'jira' | 'github' | 'todoist' | 'hubspot' | 'attio' | 'webhook';

export interface IntegrationField {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  placeholder?: string;
}

export interface IntegrationSpec {
  id: IntegrationId;
  name: string;
  /** What it does with a meeting. */
  does: string;
  kind: 'chat' | 'doc' | 'tasks' | 'crm' | 'webhook';
  fields: IntegrationField[];
  /** Where to get the token or address. */
  help: string;
  /** Works from a browser tab (CORS allowed or a simple post); otherwise the apps only. */
  web: boolean;
}

export const INTEGRATIONS: readonly IntegrationSpec[] = [
  { id: 'slack', name: 'Slack', kind: 'chat', web: true, does: 'Posts the notes to a channel.', help: 'In Slack: Apps › Incoming Webhooks › Add to a channel, then copy the webhook URL.',
    fields: [{ key: 'url', label: 'Webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/…' }] },
  { id: 'teams', name: 'Microsoft Teams', kind: 'chat', web: false, does: 'Posts the notes to a channel.', help: 'In Teams: the channel’s ••• › Workflows › “Post to a channel when a webhook request is received”, then copy its URL.',
    fields: [{ key: 'url', label: 'Workflow URL', secret: true, placeholder: 'https://…logic.azure.com/…' }] },
  { id: 'discord', name: 'Discord', kind: 'chat', web: true, does: 'Posts the notes to a channel.', help: 'In Discord: Server settings › Integrations › Webhooks › New webhook › Copy URL.',
    fields: [{ key: 'url', label: 'Webhook URL', secret: true, placeholder: 'https://discord.com/api/webhooks/…' }] },
  { id: 'notion', name: 'Notion', kind: 'doc', web: false, does: 'Creates a page with the notes under a page you choose.', help: 'notion.so/my-integrations › New integration › copy the secret; then on the parent page: ••• › Connections › add it. The page ID is the 32 characters at the end of the page’s link.',
    fields: [{ key: 'token', label: 'Integration secret', secret: true, placeholder: 'ntn_…' }, { key: 'parent', label: 'Parent page ID or link' }] },
  { id: 'linear', name: 'Linear', kind: 'tasks', web: true, does: 'Creates an issue for each action item.', help: 'Linear › Settings › Security & access › Personal API keys. The team key is the prefix of its issues (ENG in ENG-123).',
    fields: [{ key: 'token', label: 'API key', secret: true, placeholder: 'lin_api_…' }, { key: 'team', label: 'Team key', placeholder: 'ENG' }] },
  { id: 'jira', name: 'Jira', kind: 'tasks', web: false, does: 'Creates an issue for each action item.', help: 'id.atlassian.com › Security › API tokens. Site is like yourteam.atlassian.net.',
    fields: [{ key: 'site', label: 'Site', placeholder: 'yourteam.atlassian.net' }, { key: 'email', label: 'Your Atlassian email' }, { key: 'token', label: 'API token', secret: true }, { key: 'project', label: 'Project key', placeholder: 'PROJ' }] },
  { id: 'github', name: 'GitHub', kind: 'tasks', web: true, does: 'Creates an issue for each action item.', help: 'github.com › Settings › Developer settings › Fine-grained tokens, with Issues: read and write on the repository.',
    fields: [{ key: 'token', label: 'Token', secret: true, placeholder: 'github_pat_…' }, { key: 'repo', label: 'Repository', placeholder: 'owner/name' }] },
  { id: 'todoist', name: 'Todoist', kind: 'tasks', web: true, does: 'Adds each action item as a task.', help: 'Todoist › Settings › Integrations › Developer › API token.',
    fields: [{ key: 'token', label: 'API token', secret: true }] },
  { id: 'hubspot', name: 'HubSpot', kind: 'crm', web: false, does: 'Logs the notes on the contacts who were in the meeting.', help: 'HubSpot › Settings › Integrations › Private apps › Create, with CRM notes and contacts scopes; copy the access token.',
    fields: [{ key: 'token', label: 'Private app token', secret: true, placeholder: 'pat-…' }] },
  { id: 'attio', name: 'Attio', kind: 'crm', web: false, does: 'Adds the notes to the people who were in the meeting.', help: 'Attio › Workspace settings › Developers › New access token with note and record read/write.',
    fields: [{ key: 'token', label: 'Access token', secret: true }] },
  { id: 'webhook', name: 'Webhook (Zapier, Make, n8n…)', kind: 'webhook', web: true, does: 'Sends the meeting as JSON to any address, to connect anything else (Salesforce, Asana, Google Docs…).', help: 'In Zapier: Webhooks by Zapier › Catch Hook; in Make: Webhooks › Custom webhook. Paste its address.',
    fields: [{ key: 'url', label: 'Address', secret: true, placeholder: 'https://hooks.zapier.com/…' }] },
];

export const integrationSpec = (id: IntegrationId) => INTEGRATIONS.find((i) => i.id === id)!;

const secretName = (id: IntegrationId, key: string) => `meetings.integration.${id}.${key}`;

export async function loadIntegration(id: IntegrationId): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  for (const f of integrationSpec(id).fields) {
    const v = await getSecret(secretName(id, f.key)).catch(() => null);
    if (!v) return null;
    out[f.key] = v;
  }
  return out;
}

export async function saveIntegration(id: IntegrationId, values: Record<string, string> | null): Promise<void> {
  for (const f of integrationSpec(id).fields) await setSecret(secretName(id, f.key), values ? (values[f.key] ?? '').trim() || null : null);
}

export async function connectedIntegrations(): Promise<IntegrationId[]> {
  const out: IntegrationId[] = [];
  for (const i of INTEGRATIONS) if (await loadIntegration(i.id)) out.push(i.id);
  return out;
}

/** Can this integration be used here (browser vs apps)? */
export const usableHere = (id: IntegrationId) => isNative || isDesktop || integrationSpec(id).web;

// ---- Transport -----------------------------------------------------------------------------------

export interface HttpResult { status: number; body: string }

export class IntegrationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/** A request that works across origins in the apps (native or desktop HTTP) and tries fetch in a browser. */
export async function integrationFetch(method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  if (isDesktop) return invoke<HttpResult>('integration_request', { req: { method, url, headers, ...(body != null ? { body } : {}) } });
  if (isNative) {
    const r = await CapacitorHttp.request({ method, url, headers, ...(body != null ? { data: body } : {}), responseType: 'text' });
    return { status: r.status, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
  }
  try {
    const r = await fetch(url, { method, headers, ...(body != null ? { body } : {}), credentials: 'omit', referrerPolicy: 'no-referrer' });
    return { status: r.status, body: await r.text() };
  } catch {
    throw new IntegrationError('The service didn’t accept a request from a browser tab. Use the desktop or mobile app for this one, or connect it through a webhook.');
  }
}

/** Fire-and-forget post a browser can always make (no reply readable): Slack, Discord, webhooks. */
async function simplePost(url: string, json: unknown, form = false): Promise<void> {
  const body = form ? new URLSearchParams({ payload: JSON.stringify(json) }) : JSON.stringify(json);
  await fetch(url, { method: 'POST', mode: 'no-cors', body, credentials: 'omit', referrerPolicy: 'no-referrer', ...(form ? {} : { headers: { 'Content-Type': 'text/plain' } }) });
}

function ok(r: HttpResult, what: string): HttpResult {
  if (r.status >= 200 && r.status < 300) return r;
  let detail = '';
  try {
    const j = JSON.parse(r.body) as Record<string, unknown>;
    detail = String((j.message ?? (j.errors as Array<{ message?: string }> | undefined)?.[0]?.message ?? j.error ?? '') || '');
  } catch { detail = r.body.slice(0, 160); }
  const hint = r.status === 401 || r.status === 403 ? ' Check the token in Settings › Meetings › Connections.' : r.status === 404 ? ' Check the page, project or repository in Settings › Meetings › Connections.' : '';
  throw new IntegrationError(`${what} answered ${r.status}${detail ? `: ${detail}` : ''}.${hint}`, r.status);
}

const json = { 'Content-Type': 'application/json', Accept: 'application/json' };

// ---- What gets sent --------------------------------------------------------------------------------

export interface SendPayload {
  header: MeetingHeader;
  version: MeetingNotesVersion;
  /** Attendee emails (CRMs match contacts by them). */
  emails: string[];
  /** Action items chosen in the preview (tasks integrations). */
  actions: MeetingItem[];
}

export interface SendResult {
  /** Links to what was created, when the service returns them. */
  links: Array<{ label: string; url: string }>;
  summary: string;
}

/** Action items of a version (items under action-like headings). */
export function actionItems(v: MeetingNotesVersion): MeetingItem[] {
  return v.sections.filter((s) => /action|next step|to.?do|follow.?up|tasks?\b/i.test(s.heading)).flatMap((s) => s.items).filter((i) => !i.done);
}

const taskBody = (p: SendPayload, it: MeetingItem) => [
  it.owner ? `Owner: ${it.owner}` : '',
  `From the meeting “${p.header.title}”${p.header.at ? ` on ${new Date(p.header.at).toLocaleDateString()}` : ''}.`,
  p.header.link ? `Notes: ${p.header.link}` : '',
].filter(Boolean).join('\n');

function notionId(raw: string): string {
  const m = /([0-9a-f]{32})(?:\?|$|#)/i.exec(raw.replace(/-/g, '')) ?? /([0-9a-f]{32})/i.exec(raw.replace(/-/g, ''));
  if (!m) throw new IntegrationError('The Notion parent page ID should be the 32 characters at the end of the page’s link.');
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Sends to one integration. */
export async function sendTo(id: IntegrationId, p: SendPayload): Promise<SendResult> {
  const cfg = await loadIntegration(id);
  if (!cfg) throw new IntegrationError(`${integrationSpec(id).name} isn’t connected yet. Connect it in Settings › Meetings › Connections.`);
  const web = !isNative && !isDesktop;
  switch (id) {
    case 'slack': {
      const text = meetingSlack(p.header, p.version);
      if (web) { await simplePost(cfg.url!, { text }, true); return { links: [], summary: 'Posted to Slack' }; }
      ok(await integrationFetch('POST', cfg.url!, json, JSON.stringify({ text })), 'Slack');
      return { links: [], summary: 'Posted to Slack' };
    }
    case 'discord': {
      const content = meetingMarkdown(p.header, p.version, { stamps: false }).replace(/^# (.*)$/m, '**$1**').replace(/^## (.*)$/gm, '**$1**').slice(0, 1990);
      if (web) { await simplePost(cfg.url!, { content }); return { links: [], summary: 'Posted to Discord' }; }
      ok(await integrationFetch('POST', cfg.url!, json, JSON.stringify({ content })), 'Discord');
      return { links: [], summary: 'Posted to Discord' };
    }
    case 'teams': {
      const md = meetingMarkdown(p.header, p.version, { stamps: false });
      const card = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: md.slice(0, 20000), wrap: true }] } }] };
      ok(await integrationFetch('POST', cfg.url!, json, JSON.stringify(card)), 'Teams');
      return { links: [], summary: 'Posted to Teams' };
    }
    case 'webhook': {
      const payload = { type: 'inkwright.meeting', title: p.header.title, at: p.header.at ? new Date(p.header.at).toISOString() : null, attendees: p.header.attendees ?? [], link: p.header.link ?? null, tldr: p.version.tldr ?? null, sections: p.version.sections.map((s) => ({ heading: s.heading, items: s.items.map((i) => ({ text: i.text, owner: i.owner ?? null, done: i.done ?? null, yours: !!i.mine })) })), actionItems: p.actions.map((i) => ({ text: i.text, owner: i.owner ?? null })), markdown: meetingMarkdown(p.header, p.version) };
      if (web) { await simplePost(cfg.url!, payload); return { links: [], summary: 'Sent to your webhook' }; }
      ok(await integrationFetch('POST', cfg.url!, json, JSON.stringify(payload)), 'The webhook');
      return { links: [], summary: 'Sent to your webhook' };
    }
    case 'notion': {
      const body = { parent: { page_id: notionId(cfg.parent!) }, properties: { title: { title: [{ type: 'text', text: { content: p.header.title.slice(0, 200) } }] } }, children: meetingNotionBlocks(p.header, p.version) };
      const r = ok(await integrationFetch('POST', 'https://api.notion.com/v1/pages', { ...json, Authorization: `Bearer ${cfg.token}`, 'Notion-Version': '2022-06-28' }, JSON.stringify(body)), 'Notion');
      const url = (JSON.parse(r.body) as { url?: string }).url;
      return { links: url ? [{ label: 'Notion page', url }] : [], summary: 'Created a Notion page' };
    }
    case 'linear': {
      const auth = { ...json, Authorization: cfg.token! };
      const q = async (query: string, variables: Record<string, unknown>) => {
        const r = ok(await integrationFetch('POST', 'https://api.linear.app/graphql', auth, JSON.stringify({ query, variables })), 'Linear');
        const j = JSON.parse(r.body) as { data?: any; errors?: Array<{ message: string }> };
        if (j.errors?.length) throw new IntegrationError(`Linear: ${j.errors[0]!.message}`);
        return j.data;
      };
      const teams = await q('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: cfg.team!.trim().toUpperCase() });
      const teamId = teams?.teams?.nodes?.[0]?.id;
      if (!teamId) throw new IntegrationError(`Linear has no team with the key ${cfg.team}.`);
      const links: SendResult['links'] = [];
      for (const it of p.actions) {
        const d = await q('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }', { input: { teamId, title: it.text.slice(0, 250), description: taskBody(p, it) } });
        const iss = d?.issueCreate?.issue;
        if (iss) links.push({ label: iss.identifier, url: iss.url });
      }
      return { links, summary: `Created ${links.length} Linear ${links.length === 1 ? 'issue' : 'issues'}` };
    }
    case 'github': {
      const repo = cfg.repo!.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new IntegrationError('The GitHub repository should look like owner/name.');
      const links: SendResult['links'] = [];
      for (const it of p.actions) {
        const r = ok(await integrationFetch('POST', `https://api.github.com/repos/${repo}/issues`, { ...json, Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' }, JSON.stringify({ title: it.text.slice(0, 250), body: taskBody(p, it) })), 'GitHub');
        const j = JSON.parse(r.body) as { html_url?: string; number?: number };
        if (j.html_url) links.push({ label: `#${j.number}`, url: j.html_url });
      }
      return { links, summary: `Created ${links.length} GitHub ${links.length === 1 ? 'issue' : 'issues'}` };
    }
    case 'jira': {
      const site = cfg.site!.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const auth = `Basic ${btoa(`${cfg.email!.trim()}:${cfg.token!.trim()}`)}`;
      const links: SendResult['links'] = [];
      for (const it of p.actions) {
        const fields = { project: { key: cfg.project!.trim().toUpperCase() }, summary: it.text.slice(0, 250), issuetype: { name: 'Task' }, description: { type: 'doc', version: 1, content: taskBody(p, it).split('\n').map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) } };
        const r = ok(await integrationFetch('POST', `https://${site}/rest/api/3/issue`, { ...json, Authorization: auth }, JSON.stringify({ fields })), 'Jira');
        const key = (JSON.parse(r.body) as { key?: string }).key;
        if (key) links.push({ label: key, url: `https://${site}/browse/${key}` });
      }
      return { links, summary: `Created ${links.length} Jira ${links.length === 1 ? 'issue' : 'issues'}` };
    }
    case 'todoist': {
      let n = 0;
      for (const it of p.actions) {
        ok(await integrationFetch('POST', 'https://api.todoist.com/api/v1/tasks', { ...json, Authorization: `Bearer ${cfg.token}` }, JSON.stringify({ content: it.text.slice(0, 500), description: taskBody(p, it) })), 'Todoist');
        n++;
      }
      return { links: [], summary: `Added ${n} ${n === 1 ? 'task' : 'tasks'} to Todoist` };
    }
    case 'hubspot': {
      const auth = { ...json, Authorization: `Bearer ${cfg.token}` };
      const ids: string[] = [];
      for (const email of p.emails.slice(0, 20)) {
        const r = ok(await integrationFetch('POST', 'https://api.hubapi.com/crm/v3/objects/contacts/search', auth, JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], limit: 1 })), 'HubSpot');
        const id = (JSON.parse(r.body) as { results?: Array<{ id: string }> }).results?.[0]?.id;
        if (id) ids.push(id);
      }
      const html = meetingMarkdown(p.header, p.version, { stamps: false }).replace(/\n/g, '<br>');
      const body = { properties: { hs_timestamp: new Date(p.header.at ?? Date.now()).toISOString(), hs_note_body: html.slice(0, 60000) }, associations: ids.map((id) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] })) };
      ok(await integrationFetch('POST', 'https://api.hubapi.com/crm/v3/objects/notes', auth, JSON.stringify(body)), 'HubSpot');
      return { links: [], summary: ids.length ? `Logged on ${ids.length} HubSpot ${ids.length === 1 ? 'contact' : 'contacts'}` : 'Logged in HubSpot (no matching contacts found)' };
    }
    case 'attio': {
      const auth = { ...json, Authorization: `Bearer ${cfg.token}` };
      let n = 0;
      const content = meetingMarkdown(p.header, p.version, { stamps: false });
      for (const email of p.emails.slice(0, 20)) {
        const r = ok(await integrationFetch('POST', 'https://api.attio.com/v2/objects/people/records/query', auth, JSON.stringify({ filter: { email_addresses: email }, limit: 1 })), 'Attio');
        const rid = (JSON.parse(r.body) as { data?: Array<{ id?: { record_id?: string } }> }).data?.[0]?.id?.record_id;
        if (!rid) continue;
        ok(await integrationFetch('POST', 'https://api.attio.com/v2/notes', auth, JSON.stringify({ data: { parent_object: 'people', parent_record_id: rid, title: p.header.title.slice(0, 200), format: 'markdown', content } })), 'Attio');
        n++;
      }
      return { links: [], summary: n ? `Added to ${n} ${n === 1 ? 'person' : 'people'} in Attio` : 'No one from the meeting is in Attio yet' };
    }
  }
}
