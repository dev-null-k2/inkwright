/**
 * MCP Apps (extension `io.modelcontextprotocol/ui`, SEP-1865; apps spec 2026-01-26): interactive
 * views that Claude, ChatGPT and other hosts render inside the chat, next to a tool result.
 *
 * - `ui://inkwright/note-page.html` — a rendered note page (the ink as SVG) with page turning;
 *   attached to `show_note_page`.
 * - `ui://inkwright/search.html` — a search results picker; attached to `search_notes`. Picking a
 *   result previews the page in place and can ask the assistant about it.
 * - `ui://inkwright/approvals.html` — an approval card for actions waiting for the user's OK
 *   (from routines and other unattended runs); attached to `list_pending_approvals`, its buttons
 *   call `decide_approval`.
 *
 * Every tool still returns plain text, so hosts without MCP Apps (and the model itself) get a
 * readable fallback. Views are single self-contained HTML files with no external scripts, styles
 * or fonts (nothing to allow in a CSP), talk to the host only through the MCP Apps postMessage
 * JSON-RPC (`ui/initialize`, `ui/notifications/tool-result`, `tools/call`, `ui/message`,
 * `ui/notifications/size-changed`), and insert every piece of note text with `textContent`, never
 * as HTML. Page images are shown as `<img>` data URLs, where SVG scripts can't run.
 */

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const UI_MIME = 'text/html;profile=mcp-app';
/** MCP Apps protocol version the views speak. */
export const UI_PROTOCOL_VERSION = '2026-01-26';

export const NOTE_PAGE_UI = 'ui://inkwright/note-page.html';
export const SEARCH_UI = 'ui://inkwright/search.html';
export const APPROVALS_UI = 'ui://inkwright/approvals.html';

/** Where a tool result carries the page SVG for the view (kept out of the model's context). */
export const SVG_META_KEY = 'dev.inkwright/pageSvg';

/**
 * Tool `_meta` linking a view: the standard `ui.resourceUri`, plus the deprecated flat key and the
 * ChatGPT alias that older hosts still read.
 */
export function uiToolMeta(uri: string, visibility?: Array<'model' | 'app'>): Record<string, unknown> {
  return { ui: { resourceUri: uri, ...(visibility ? { visibility } : {}) }, 'ui/resourceUri': uri, 'openai/outputTemplate': uri };
}

/** Resource `_meta.ui`: a border, and an empty CSP (the views load nothing from the network). */
export const UI_RESOURCE_META = { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } };

// ---- Shared view shell ---------------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light;--bg:var(--color-background-primary,#fbfafc);--bg2:var(--color-background-secondary,#f1eff3);--fg:var(--color-text-primary,#2b2330);--fg2:var(--color-text-secondary,#5f5666);--line:var(--color-border-primary,rgba(43,35,48,.14));--accent:#356b53;--accent-soft:rgba(53,107,83,.13);--seal:#b3412f;--paper:#fffdf8;--radius:var(--border-radius-md,12px);--font:var(--font-sans,'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);--title:'Brygada 1918','Iowan Old Style',Georgia,serif}
:root[data-theme=dark]{color-scheme:dark;--bg:var(--color-background-primary,#1a161c);--bg2:var(--color-background-secondary,#241f27);--fg:var(--color-text-primary,#ece8ee);--fg2:var(--color-text-secondary,#a79fad);--line:var(--color-border-primary,rgba(236,232,238,.14));--accent:#7fbf9f;--accent-soft:rgba(127,191,159,.16);--seal:#e07a66;--paper:#f7f3ea}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.45 var(--font)}
main{padding:12px;display:flex;flex-direction:column;gap:10px}
h1{font:600 17px/1.3 var(--title);margin:0}
.muted{color:var(--fg2);font-size:12.5px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.spacer{flex:1}
button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:999px;padding:5px 12px;cursor:pointer}
button:hover{background:var(--bg2)}button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--seal);border-color:var(--seal)}
button:focus-visible,.hit:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sheet{background:var(--paper);border-radius:2px;box-shadow:0 1px 2px rgba(43,30,50,.12),0 10px 24px -16px rgba(43,30,50,.45);overflow:hidden}
.sheet img{display:block;width:100%;height:auto}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.hit{border:1px solid var(--line);border-radius:var(--radius);padding:8px 10px;cursor:pointer;background:var(--bg)}
.hit[aria-selected=true]{border-color:var(--accent);background:var(--accent-soft)}
.hit .title{font-weight:600}
mark{background:var(--accent-soft);color:inherit;border-radius:3px;padding:0 1px}
.card{border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;background:var(--bg);display:flex;flex-direction:column;gap:6px}
.empty{color:var(--fg2);padding:8px 0}
`;

/**
 * Minimal MCP Apps client: JSON-RPC over postMessage with the host, theme from the host context,
 * and size reports so the host can fit the iframe. Views define `onResult(result)`.
 */
const BRIDGE = `
const pending=new Map();let seq=0;
function send(m){window.parent.postMessage(Object.assign({jsonrpc:'2.0'},m),'*')}
function rpc(method,params){const id=++seq;return new Promise((res,rej)=>{pending.set(id,{res,rej});send({id,method,params})})}
function notify(method,params){send({method,params:params||{}})}
function applyContext(c){if(!c)return;if(c.theme)document.documentElement.dataset.theme=c.theme;const v=c.styles&&c.styles.variables;if(v)for(const k in v)if(v[k])document.documentElement.style.setProperty(k,v[k])}
async function callTool(name,args){const r=await rpc('tools/call',{name,arguments:args});if(r&&r.isError)throw new Error(textOf(r)||'The tool failed.');return r}
function textOf(r){return ((r&&r.content)||[]).filter(c=>c.type==='text').map(c=>c.text).join('\\n')}
function say(text){return rpc('ui/message',{role:'user',content:[{type:'text',text}]}).catch(()=>{})}
window.addEventListener('message',e=>{if(e.source!==window.parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
 if(m.id!==undefined&&!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message||'Error')):p.res(m.result);return}
 if(m.method==='ui/notifications/tool-result')onResult(m.params);
 else if(m.method==='ui/notifications/host-context-changed')applyContext(m.params);
 else if(m.method==='ui/resource-teardown'&&m.id!==undefined)send({id:m.id,result:{}});
 else if(m.id!==undefined&&m.method)send({id:m.id,error:{code:-32601,message:'Method not found'}})});
let lastH=0;function report(){const h=Math.ceil(document.documentElement.scrollHeight);if(h!==lastH){lastH=h;notify('ui/notifications/size-changed',{height:h})}}
new ResizeObserver(report).observe(document.documentElement);
rpc('ui/initialize',{appInfo:{name:'inkwright',version:'1'},appCapabilities:{availableDisplayModes:['inline']},protocolVersion:'${UI_PROTOCOL_VERSION}'}).then(r=>{applyContext(r&&r.hostContext);notify('ui/notifications/initialized',{});report()}).catch(()=>{});
function el(tag,attrs,...kids){const n=document.createElement(tag);for(const k in attrs||{}){if(k==='class')n.className=attrs[k];else if(k.startsWith('on'))n.addEventListener(k.slice(2),attrs[k]);else n.setAttribute(k,attrs[k])}for(const c of kids)if(c!=null)n.append(c);return n}
function svgImg(svg,alt){const img=el('img',{alt:alt||'Note page'});img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));return img}
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main id="app">${body}</main><script>${BRIDGE}\n${script}</script></body></html>`;
}

/** Renders one note page from a `show_note_page` result; turns pages through the same tool. */
const NOTE_PAGE_SCRIPT = `
const app=document.getElementById('app');let cur=null;
async function svgFor(r){const meta=r._meta||{};if(meta['${SVG_META_KEY}'])return meta['${SVG_META_KEY}'];const s=r.structuredContent||{};
 try{const rr=await rpc('resources/read',{uri:'inkwright://notes/'+encodeURIComponent(s.noteId)+'/pages/'+s.page+'.svg'});return rr.contents[0].text}catch{return null}}
async function onResult(r){const s=r&&r.structuredContent;if(!s||!s.noteId){app.replaceChildren(el('p',{class:'empty'},textOf(r)||'Nothing to show.'));return}
 cur=s;const svg=await svgFor(r);
 const go=async d=>{try{onResult(await callTool('show_note_page',{id:s.noteId,page:s.page+d}))}catch(e){status.textContent=e.message}};
 const status=el('span',{class:'muted'});
 app.replaceChildren(
  el('div',{class:'row'},el('h1',{},s.title||'Untitled'),el('span',{class:'spacer'}),el('span',{class:'muted'},'Page '+s.page+' of '+s.pageCount)),
  el('div',{class:'sheet'},svg?svgImg(svg,(s.title||'Note')+', page '+s.page):el('p',{class:'empty'},'This page could not be drawn.')),
  el('div',{class:'row'},el('button',{onclick:()=>go(-1),...(s.page<=1?{disabled:''}:{})},'Previous page'),el('button',{onclick:()=>go(1),...(s.page>=s.pageCount?{disabled:''}:{})},'Next page'),el('span',{class:'spacer'}),status,
   el('button',{onclick:()=>say('About page '+s.page+' of my note “'+(s.title||'Untitled')+'” (id '+s.noteId+'): ')},'Ask about this page')))}
app.replaceChildren(el('p',{class:'empty'},'Loading the page…'));
`;

/** Lists search hits; picking one previews the page in place. */
const SEARCH_SCRIPT = `
const app=document.getElementById('app');
function marked(snippet){const out=el('span',{class:'muted'});const parts=String(snippet||'').split(/(«[^»]*»)/);for(const p of parts){if(p.startsWith('«')&&p.endsWith('»'))out.append(el('mark',{},p.slice(1,-1)));else out.append(p)}return out}
function onResult(r){const s=r&&r.structuredContent;const hits=(s&&s.hits)||[];
 if(!hits.length){app.replaceChildren(el('p',{class:'empty'},(s&&s.query)?'No notes match “'+s.query+'”.':(textOf(r)||'No results.')));return}
 const preview=el('div',{});const list=el('ul',{role:'listbox','aria-label':'Matching notes'});
 for(const h of hits){const li=el('li',{class:'hit',role:'option',tabindex:'0','aria-selected':'false'},
   el('div',{class:'row'},el('span',{class:'title'},h.title||'Untitled'),el('span',{class:'spacer'}),el('span',{class:'muted'},'Page '+h.page+(h.notebook?' · '+h.notebook:''))),marked(h.snippet));
  const pick=async()=>{for(const x of list.children)x.setAttribute('aria-selected','false');li.setAttribute('aria-selected','true');preview.replaceChildren(el('p',{class:'muted'},'Opening…'));
   try{const p=await callTool('show_note_page',{id:h.id,page:h.page});const st=p.structuredContent||{};const svg=(p._meta||{})['${SVG_META_KEY}'];
    preview.replaceChildren(el('div',{class:'sheet'},svg?svgImg(svg,h.title):el('p',{class:'empty'},textOf(p))),el('div',{class:'row'},el('span',{class:'muted'},'Page '+st.page+' of '+st.pageCount),el('span',{class:'spacer'}),el('button',{class:'primary',onclick:()=>say('Use my note “'+(h.title||'Untitled')+'” (id '+h.id+').')},'Use this note')))}
   catch(e){preview.replaceChildren(el('p',{class:'empty'},e.message))}};
  li.addEventListener('click',pick);li.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}});list.append(li)}
 app.replaceChildren(el('div',{class:'row'},el('h1',{},'Notes matching “'+s.query+'”'),el('span',{class:'spacer'}),el('span',{class:'muted'},hits.length+' found')),list,preview)}
app.replaceChildren(el('p',{class:'empty'},'Searching…'));
`;

/** Pending approvals with Approve / Not now buttons (decide_approval). */
const APPROVALS_SCRIPT = `
const app=document.getElementById('app');
function ago(ms){const m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' d ago'}
function onResult(r){const s=r&&r.structuredContent;const items=(s&&s.approvals)||[];
 if(!items.length){app.replaceChildren(el('p',{class:'empty'},'Nothing is waiting for your OK.'));return}
 const list=el('ul',{});
 for(const a of items){const status=el('span',{class:'muted'});const yes=el('button',{class:'primary'},'Allow');const no=el('button',{class:'danger'},'Don’t allow');
  const decide=async approve=>{yes.disabled=no.disabled=true;status.textContent=approve?'Working…':'';try{const res=await callTool('decide_approval',{id:a.id,approve});const d=(res.structuredContent||{}).approval||{};status.textContent=d.status==='approved'?'Done. '+(d.outcome||''):d.status==='denied'?'Not done.':(d.outcome||textOf(res))}catch(e){status.textContent=e.message;yes.disabled=no.disabled=false}};
  yes.addEventListener('click',()=>decide(true));no.addEventListener('click',()=>decide(false));
  list.append(el('li',{class:'card'},el('div',{class:'row'},el('strong',{},a.title),el('span',{class:'spacer'}),el('span',{class:'muted'},ago(a.createdAt))),a.detail?el('span',{class:'muted'},a.detail):null,el('span',{class:'muted'},'Asked by '+a.source),el('div',{class:'row'},yes,no,status)))}
 app.replaceChildren(el('h1',{},items.length===1?'1 action is waiting for your OK':items.length+' actions are waiting for your OK'),list)}
app.replaceChildren(el('p',{class:'empty'},'Loading…'));
`;

export const UI_RESOURCES: ReadonlyArray<{ uri: string; name: string; title: string; description: string; html: string }> = [
  { uri: NOTE_PAGE_UI, name: 'note-page-view', title: 'Note page', description: 'A rendered page of a handwritten note, with page turning.', html: page('Note page', '', NOTE_PAGE_SCRIPT) },
  { uri: SEARCH_UI, name: 'search-view', title: 'Search results', description: 'Notes matching a search; pick one to preview it.', html: page('Search results', '', SEARCH_SCRIPT) },
  { uri: APPROVALS_UI, name: 'approvals-view', title: 'Waiting for your OK', description: 'Actions waiting for your approval, with Allow and Don’t allow buttons.', html: page('Waiting for your OK', '', APPROVALS_SCRIPT) },
];
