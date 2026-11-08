import type { Form, FormField } from './data.ts';

/**
 * The two pages strangers see: a shared list and a form. Plain HTML from the gateway itself, no
 * third-party anything, a strict CSP, and wording in Ukrainian or English from the browser.
 */

export type PageLang = 'uk' | 'en';

export function pageLang(req: Request): PageLang {
  return /^uk|,\s*uk/i.test(req.headers.get('Accept-Language') ?? '') ? 'uk' : 'en';
}

const S = {
  en: {
    send: 'Send',
    required: 'required',
    thanks: 'Thank you! Your answer was sent.',
    again: 'Send another answer',
    closed: 'This form is not taking answers.',
    error: 'Could not send',
    back: 'Back to the form',
    yes: 'Yes',
    choose: 'Choose…',
    privacy: 'Answers go only to the person who made this form, on their own server.',
    listAdd: 'Add',
    listPlaceholder: 'Add an item',
    listName: 'Your name (optional)',
    listClear: 'Remove ticked',
    listEmpty: 'Nothing here yet.',
    listOffline: 'Could not reach the list. Retrying…',
    listNoAccess: 'This link no longer works. Ask for a new one.',
    listPrivacy: 'Anyone with this link can see and change the list.',
    remove: 'Remove',
  },
  uk: {
    send: 'Надіслати',
    required: "обов'язково",
    thanks: 'Дякуємо! Відповідь надіслано.',
    again: 'Надіслати ще одну відповідь',
    closed: 'Ця форма не приймає відповіді.',
    error: 'Не вдалося надіслати',
    back: 'Назад до форми',
    yes: 'Так',
    choose: 'Обери…',
    privacy: 'Відповіді бачить лише автор форми, на власному сервері.',
    listAdd: 'Додати',
    listPlaceholder: 'Додати пункт',
    listName: "Твоє ім'я (необов'язково)",
    listClear: 'Прибрати відмічені',
    listEmpty: 'Тут поки порожньо.',
    listOffline: 'Немає зв’язку зі списком. Пробую ще…',
    listNoAccess: 'Це посилання більше не діє. Попроси нове.',
    listPrivacy: 'Будь-хто з цим посиланням може бачити й змінювати список.',
    remove: 'Видалити',
  },
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
:root{--bg:#f2f2f7;--s:#fff;--ink:#1d1d1f;--mut:#6e6e73;--line:rgb(60 60 67/.18);--acc:#0071e3;--acc-t:#0066cc;--soft:rgb(0 113 227/.1);--bad:#d70015;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#000;--s:#1c1c1e;--ink:#f5f5f7;--mut:#98989f;--line:rgb(84 84 88/.65);--acc-t:#4da3ff;--soft:rgb(10 132 255/.18);--bad:#ff6961}}
*{box-sizing:border-box}html{background:var(--bg);-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.47 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
main{max-width:600px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 32px) 16px calc(env(safe-area-inset-bottom) + 40px)}
h1{font-size:2rem;line-height:1.15;letter-spacing:-.025em;margin:0 0 8px}
p{margin:0 0 12px}.mut{color:var(--mut);font-size:.9375rem}
.card{background:var(--s);border-radius:18px;padding:20px;margin-top:20px}
label{display:block;font-weight:600;font-size:.9375rem;margin:16px 0 8px}label:first-child{margin-top:0}
.req{color:var(--mut);font-weight:400}
input,select,textarea{font:inherit;width:100%;min-width:0;min-height:50px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--s);color:var(--ink)}
textarea{padding:12px 16px;min-height:110px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 4px var(--soft)}
input[type=checkbox]{width:22px;height:22px;min-height:0;accent-color:var(--acc);vertical-align:middle;margin-right:8px}
button{font:inherit;font-weight:600;border:0;border-radius:14px;min-height:50px;padding:0 24px;background:var(--acc);color:#fff;cursor:pointer}
button.q{background:var(--soft);color:var(--acc-t)}button.x{background:none;color:var(--bad);min-height:36px;padding:0 8px;font-weight:400}
.send{width:100%;margin-top:24px}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.err{color:var(--bad)}ul{list-style:none;margin:0;padding:0}
.items li{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:.5px solid var(--line)}.items li:first-child{border-top:0}
.items li span{flex:1;overflow-wrap:anywhere}.items li.done span{color:var(--mut);text-decoration:line-through}
.by{color:var(--mut);font-size:.8125rem;flex:none!important}
.row{display:flex;gap:8px}.row input{flex:1}
`;

function page(lang: PageLang, title: string, body: string, nonce?: string, script?: string): Response {
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ''}connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

function fieldHtml(f: FormField, t: (typeof S)['en']): string {
  const name = `a_${esc(f.id)}`;
  const req = f.required ? ' required' : '';
  const label = `<label for="${name}">${esc(f.label)}${f.required ? ` <span class="req">(${t.required})</span>` : ''}</label>`;
  switch (f.kind) {
    case 'long':
      return `${label}<textarea id="${name}" name="${name}" maxlength="2000"${req}></textarea>`;
    case 'choice':
      return `${label}<select id="${name}" name="${name}"${req}><option value="">${t.choose}</option>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    case 'check':
      return `<label><input type="checkbox" name="${name}"${req}>${esc(f.label)}</label>`;
    default: {
      const type = { text: 'text', email: 'email', phone: 'tel', number: 'text', date: 'date' }[f.kind];
      const extra = f.kind === 'number' ? ' inputmode="decimal"' : f.kind === 'phone' ? ' autocomplete="tel"' : f.kind === 'email' ? ' autocomplete="email"' : '';
      return `${label}<input id="${name}" name="${name}" type="${type}" maxlength="2000"${extra}${req}>`;
    }
  }
}

export function formPage(lang: PageLang, f: Form, state: 'open' | 'closed' | 'full', now: number): Response {
  const t = S[lang];
  const head = `<h1>${esc(f.title)}</h1>${f.description ? `<p>${esc(f.description).replace(/\n/g, '<br>')}</p>` : ''}`;
  if (state !== 'open') return page(lang, f.title, `${head}<div class="card"><p>${t.closed}</p></div>`);
  const body = `${head}<form class="card" method="post">${f.fields.map((x) => fieldHtml(x, t)).join('')}
<div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="_t" value="${now}"><button class="send" type="submit">${t.send}</button></form><p class="mut" style="margin-top:16px">${t.privacy}</p>`;
  return page(lang, f.title, body);
}

export function formDone(lang: PageLang, f: Form): Response {
  const t = S[lang];
  return page(lang, f.title, `<h1>${esc(f.title)}</h1><div class="card"><p>${t.thanks}</p><p><a href="">${t.again}</a></p></div>`);
}

export function formError(lang: PageLang, title: string, message: string, status: number): Response {
  const t = S[lang];
  const r = page(lang, title, `<h1>${esc(title)}</h1><div class="card"><p class="err">${t.error}: ${esc(message)}</p><p><a href="">${t.back}</a></p></div>`);
  return new Response(r.body, { status, headers: r.headers });
}

/** The list page holds no data: its script reads the secret from the link's #fragment, which never reaches a server log. */
export function listPage(lang: PageLang, nonce: string): Response {
  const t = S[lang];
  const body = `<h1 id="title">…</h1><p class="mut">${t.listPrivacy}</p>
<div class="card"><form id="add" class="row"><input id="text" maxlength="200" placeholder="${t.listPlaceholder}" aria-label="${t.listPlaceholder}"><button type="submit">${t.listAdd}</button></form>
<ul id="items" class="items" style="margin-top:12px"></ul><p id="empty" class="mut" hidden>${t.listEmpty}</p>
<button id="clear" class="q" type="button" hidden style="margin-top:12px">${t.listClear}</button></div>
<label for="by" style="margin-top:20px">${t.listName}</label><input id="by" maxlength="40" autocomplete="name">
<p id="msg" class="err" role="status" style="margin-top:12px"></p>`;
  const script = `
const T=${JSON.stringify({ offline: t.listOffline, noAccess: t.listNoAccess, remove: t.remove })};
const id=location.pathname.split('/')[2], secret=location.hash.slice(1), $=s=>document.getElementById(s);
const by=$('by'); try{by.value=localStorage.getItem('hub-list-by')||''}catch{}
by.onchange=()=>{try{localStorage.setItem('hub-list-by',by.value)}catch{}};
let version=0;
async function call(path,body){const r=await fetch('/l/'+id+path,{method:body?'POST':'GET',headers:{'X-List-Secret':secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 if(r.status===401||r.status===404){$('msg').textContent=T.noAccess;throw 0} const j=await r.json(); if(!r.ok){$('msg').textContent=j.error||'';throw 0} $('msg').textContent=''; return j.list}
function draw(l){version=l.version;document.title=l.title;$('title').textContent=l.title;const ul=$('items');ul.replaceChildren();
 for(const it of l.items){const li=document.createElement('li');if(it.done)li.className='done';const cb=document.createElement('input');cb.type='checkbox';cb.checked=it.done;cb.setAttribute('aria-label',it.text);
  cb.onchange=()=>change({op:'toggle',id:it.id,done:cb.checked});const sp=document.createElement('span');sp.textContent=it.text;const who=document.createElement('span');who.className='by';who.textContent=it.by;
  const x=document.createElement('button');x.className='x';x.type='button';x.textContent='×';x.setAttribute('aria-label',T.remove+': '+it.text);x.onclick=()=>change({op:'remove',id:it.id});li.append(cb,sp,who,x);ul.append(li)}
 $('empty').hidden=l.items.length>0;$('clear').hidden=!l.items.some(i=>i.done)}
async function change(op){try{draw(await call('/change',{...op,by:by.value}))}catch{}}
async function poll(){if(document.hidden)return;try{const l=await call('/data');if(l.version!==version)draw(l)}catch{if(!$('msg').textContent)$('msg').textContent=T.offline}}
$('add').onsubmit=e=>{e.preventDefault();const v=$('text').value.trim();if(!v)return;$('text').value='';change({op:'add',text:v})};
$('clear').onclick=()=>change({op:'clearDone'});
poll();setInterval(poll,5000);document.addEventListener('visibilitychange',poll);`;
  return page(lang, '…', body, nonce, script);
}
