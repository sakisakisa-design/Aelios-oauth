import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { identityNamespace, invalidateSettingsCache, loadConfig, validateConfig } from "./config";
import { describeSettings } from "./settings";

async function ownerOnly(request: Request, env: Env): Promise<boolean> {
  const auth = await authenticate(request, env);
  return auth.ok && ["CHATBOX_API_KEY", "DEBUG_API_KEY"].includes(auth.keyName);
}
/** Reports the values this Worker was deployed with, so the page can show them as placeholders. */
export async function handleGatewayEnv(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  let settings = {};
  try { settings = (await loadConfig(env)).settings || {}; } catch { settings = {}; }
  return Response.json(describeSettings(env, settings), { headers: { "cache-control": "no-store" } });
}
export async function handleGatewayAdmin(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  try {
    if (request.method === "GET") return Response.json(await loadConfig(env), { headers: { "cache-control": "no-store" } });
    if (request.method !== "PUT") return Response.json({ error: "Use GET or PUT" }, { status: 405, headers: { allow: "GET, PUT" } });
    let config;
    try { config = validateConfig(await request.json()); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid config" }, { status: 400 }); }
    await env.DB.prepare(`INSERT INTO gateway_config (id, config_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(config), new Date().toISOString()).run();
    invalidateSettingsCache();
    return Response.json({ ok: true, identities: config.identities.length, settings: Object.keys(config.settings || {}).length });
  } catch { return Response.json({ error: "Configuration store unavailable. Apply D1 migrations first." }, { status: 503 }); }
}
/** Read-only recall explanations for one configured identity, including empty/error decisions. */
export async function handleRecallHistory(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  const slug = new URL(request.url).searchParams.get("identity");
  const config = await loadConfig(env);
  const identity = config.identities.find(i => i.slug === slug);
  if (!identity) return Response.json({ error: "Unknown identity" }, { status: 400 });
  const rows = await env.DB.prepare(`SELECT id, created_at, payload_json FROM memory_events
    WHERE namespace = ? AND event_type = 'recall_explain' AND json_extract(payload_json, '$.identity') = ?
    ORDER BY created_at DESC, id DESC LIMIT 20`).bind(identityNamespace(identity), identity.slug)
    .all<{ id: string; created_at: string; payload_json: string }>();
  return Response.json({ items: (rows.results || []).map(row => ({
    id: row.id, created_at: row.created_at, ...JSON.parse(row.payload_json)
  })) }, { headers: { "cache-control": "no-store" } });
}
export function gatewayAdminPage(): Response {
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const KEY_OPTIONS: [string, string][] = [
  ["CHATBOX_API_KEY", "主钥匙"], ["IM_API_KEY", "第二把钥匙"],
  ["DEBUG_API_KEY", "维护钥匙"], ["GUIDE_DOG_API_KEY", "导盲犬钥匙"]
];
const keyOptionsJson = JSON.stringify(KEY_OPTIONS);

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aelios · 记忆网关</title><style>
::root{color-scheme:dark;font:15px/1.6 system-ui;background:#10151b;color:#e4e9ef}
body{max-width:760px;margin:auto;padding:32px 20px}h1{font-size:28px;margin:8px 0}h2{font-size:18px;margin:0 0 6px}
p{color:#a6b4c3;margin:6px 0}a{color:#8ad5ca}code{background:#101720;border:1px solid #2c3846;border-radius:5px;padding:1px 5px;font:13px ui-monospace,monospace}
section{background:#19212b;border:1px solid #303b49;border-radius:14px;padding:22px;margin:20px 0}
label{display:block;color:#b8c6d6;font-size:13px;margin:10px 0}
input,select,button{font:inherit;border-radius:7px;border:1px solid #3b4b5e;padding:10px;box-sizing:border-box}
input,select{background:#101720;color:#e4e9ef;width:100%;margin-top:5px}
button{background:#2b6f66;border-color:#3a8f84;color:#fff;cursor:pointer;padding:10px 18px}
button.ghost{background:transparent;color:#8ad5ca;border-color:#3b4b5e}
button.danger{background:transparent;color:#d98a8a;border-color:#5e3b3b;padding:6px 12px;font-size:13px}
.hint{color:#7d8fa3;font-size:12.5px;margin-top:4px}
.card{border:1px solid #303b49;border-radius:12px;padding:16px;margin:14px 0;background:#151c25}
.card h3{margin:0 0 4px;font-size:16px;display:flex;justify-content:space-between;align-items:center}
.keys{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:6px}
.keys label{display:flex;align-items:center;gap:6px;margin:0}
.keys input{width:auto;margin:0}
#status{min-height:24px;color:#8ad5ca;margin-top:10px}
details{margin-top:8px}summary{cursor:pointer;color:#a6b4c3}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
</style><body>
<small>AELIOS / MEMORY GATEWAY</small><h1>带着记忆，随处接入。</h1>
<p>一个助手一个地址，模型名原样透传。只有主模型有记忆、进 Dream，其余模型安静路过。<a href="/admin">记忆管理 →</a></p>

<section><label>管理钥匙（Worker 设置里的 CHATBOX_API_KEY，只留在本页）<input id="key" type="password" autocomplete="off"></label>
<div class="row"><button id="load">读取</button><button id="save">保存</button></div><div id="status" role="status" aria-live="polite"></div></section>

<section><h2>上游连接</h2>
<label>上游地址<input id="cfAddress" placeholder="CF 账号 ID(32 位),或完整地址,如 new-api 的 https://…/v1"><div class="hint">最省心:填 32 位账号 ID,贴 Cloudflare 网关网址也能认。chat 走 compat,全 provider;messages / responses 走各 provider 的原生端点,模型名记得带 <code>provider/模型</code> 前缀;模型列表走 <code>…/compat/models</code>。BYOK 全程生效,provider 钥匙在 AI Gateway 仪表盘里存。Gateway ID 在下面环境设置里,默认 <code>default</code>。填别的 OpenAI 兼容地址(如 new-api)就原样用。令牌去 Worker Secrets 加 <code>CLOUDFLARE_API_TOKEN</code>。</div></label></section>

<section><h2>助手</h2><p class="hint">每位三格：名字、主模型、钥匙。主模型支持 <code>*</code> 通配，写不写 <code>anthropic/</code> 前缀都能认。</p>
<div id="identities"></div><button id="addIdentity" class="ghost">+ 添加助手</button></section>

<section><h2>环境设置</h2><p class="hint">每格留空就是用默认值，灰字是当前生效的值。点「读取」后出现。</p><div id="settings"></div>
<h3>钥匙状态</h3><p class="hint">钥匙都在 Worker 设置里，这里只看在不在。</p><div id="secrets"></div></section>

<section><h2>为什么想起这件事</h2><p>查看最近 20 次召回，包括没有选中记忆和判断失败的原因。</p>
<label>助手<select id="recallIdentity"></select></label><button id="loadRecalls" class="ghost">查看最近召回</button>
<div id="recallHistory" aria-live="polite"></div></section>

<section><details><summary>接入约定</summary>
<p>每位一个地址：Chatbox 等 OpenAI 兼容客户端填 <code>https://本站/名字/v1</code>；Claude Code 的 ANTHROPIC_BASE_URL 填 <code>https://本站/名字</code>；Codex 的 base_url 填 <code>https://本站/名字/v1</code> 并设 wire_api = "responses"。不带名字的 <code>/v1</code> 走这把钥匙的第一位。</p>
<p>模型名原样送到 CF，选错人家（比如在 Claude Code 里点 GPT）由 CF 报错。轮询和 fallback 在 CF AI Gateway 的动态路由里配，这里不管。可用 <code>x-aelios-purpose: auxiliary</code> 标记内部任务，不召回也不进 Dream。临时记忆只跟着主模型的当次请求走，工具续轮不带。</p></details></section>

<script>
const el=id=>document.getElementById(id),status=m=>el('status').textContent=m;
const KEY_OPTIONS=${keyOptionsJson};
let settingsLoaded=false;
function h(tag,attrs,...kids){const n=document.createElement(tag);for(const k in attrs||{}){if(k==='class')n.className=attrs[k];else if(k==='text')n.textContent=attrs[k];else n.setAttribute(k,attrs[k])}for(const kid of kids)n.append(kid);return n}
function field(labelText,hintText,value,placeholder){const input=h('input',{value:value||'',placeholder:placeholder||''});const label=h('label',{text:labelText});label.append(input);if(hintText)label.append(h('div',{class:'hint',text:hintText}));return{label,input}}
function addCard(data){
  data=data||{};
  const slug=field('名字','就是地址里那一段，比如 coder。小号英文，别用空格。',data.slug,'coder');
  const models=field('主模型（逗号分隔，可多选）','只有主模型的对话召回记忆、进 Dream；其余模型在这个助手名下安静透传。',(data.models||[]).join(', '),'anthropic/claude-opus-4-5, *sonnet*');
  const ns=field('写入空间','新对话写到这里，留空就和名字同名。',data.namespace,'');
  const reads=field('召回空间（逗号分隔）','留空只读写入空间；填写多个空间可共享、保留旧库；填 [] 只记录不召回。',data.readNamespaces ? (data.readNamespaces.length ? data.readNamespaces.join(', ') : '[]') : '', '');
  const keysBox=h('div',{class:'keys'});
  const chosen=data.keys||['CHATBOX_API_KEY'];
  const boxes=KEY_OPTIONS.map(([name,label])=>{const input=h('input',{type:'checkbox'});input.checked=chosen.includes(name);const l=h('label',{text:label});l.prepend(input);keysBox.append(l);return{input,name}});
  const thinking=field('Claude 思考块','passthrough 保留思考，未明确关闭思考时跳过注入；drop_block 允许临时记忆，需上游支持 beta，失配的思考由上游丢弃。',data.anthropicThinking||'passthrough','');
  const budget=field('单次记忆字数上限','留空默认 6000。',data.maxMemoryChars||'','');
  const del=h('button',{class:'danger',text:'移除'});del.onclick=()=>card.remove();
  const title=h('h3',{text:data.slug||'新助手'},del);
  slug.input.addEventListener('input',()=>{title.firstChild.textContent=slug.input.value.trim()||'新助手'});
  const advanced=h('details');advanced.append(h('summary',{text:'高级'}),thinking.label,budget.label);
  const card=h('div',{class:'card'},title,slug.label,models.label,ns.label,reads.label,h('label',{text:'谁能用这个助手'}),keysBox,advanced);
  card.collect=()=>{
    const keys=boxes.filter(b=>b.input.checked).map(b=>b.name);
    const identity={slug:slug.input.value.trim(),keys,models:models.input.value.split(/[,，\\n]/).map(s=>s.trim()).filter(Boolean)};
    if(ns.input.value.trim())identity.namespace=ns.input.value.trim();
    if(reads.input.value.trim())identity.readNamespaces=reads.input.value.trim()==='[]'?[]:reads.input.value.split(/[,，\\n]/).map(s=>s.trim()).filter(Boolean);
    if(thinking.input.value.trim()&&thinking.input.value.trim()!=='passthrough')identity.anthropicThinking=thinking.input.value.trim();
    if(budget.input.value.trim())identity.maxMemoryChars=parseInt(budget.input.value.trim(),10);
    return identity;
  };
  el('identities').append(card);
}
function render(config){
  el('cfAddress').value=(config.upstream&&config.upstream.address)||'';
  el('identities').innerHTML='';
  (config.identities||[]).forEach(addCard);
  recallRevision++;
  el('recallIdentity').replaceChildren(...(config.identities||[]).map(i=>h('option',{value:i.slug,text:i.slug})));
  el('recallHistory').replaceChildren();
}
function collect(){
  const config={version:3,identities:[...document.querySelectorAll('#identities .card')].map(c=>c.collect())};
  const address=el('cfAddress').value.trim();
  if(address)config.upstream={address};
  if(settingsLoaded){const settings={};document.querySelectorAll('#settings input[data-name]').forEach(i=>{if(i.value.trim())settings[i.dataset.name]=i.value.trim()});config.settings=settings}
  return config;
}
function renderEnv(data){
  const box=el('settings');box.innerHTML='';
  data.groups.forEach(g=>{const f=h('fieldset');f.append(h('legend',{text:g.group}));
      g.items.forEach(item=>{const l=h('label',{text:item.label+(item.hint?'　'+item.hint:'')});
      const i=h('input',{value:item.value,placeholder:item.deployed||'未设置，用代码默认值'});i.dataset.name=item.name;i.title=item.name;l.append(i);f.append(l)});
    box.append(f)});
  el('secrets').innerHTML='';
  data.secrets.forEach(x=>el('secrets').append(h('div',{text:(x.present?'✓ ':'— ')+x.label+' '})));
}
async function request(method,body){
  const r=await fetch('/api/gateway/config',{method,headers:{authorization:'Bearer '+el('key').value,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();if(!r.ok)throw Error(data.error||r.status);return data;
}
el('load').onclick=async()=>{try{const config=await request('GET');render(config);
  const r=await fetch('/api/gateway/env',{headers:{authorization:'Bearer '+el('key').value}});renderEnv(await r.json());settingsLoaded=true;
  status('读好了。')}catch(e){status(e.message)}};
el('save').onclick=async()=>{try{const data=await request('PUT',collect());status('保存好了，'+data.identities+' 个助手。环境设置最长 10 秒全网生效。')}catch(e){status(e.message)}};
el('addIdentity').onclick=()=>addCard();
let recallRevision=0;
el('recallIdentity').onchange=()=>{recallRevision++;el('recallHistory').replaceChildren()};
el('loadRecalls').onclick=async()=>{
  const revision=++recallRevision, identity=el('recallIdentity').value;
  el('recallHistory').replaceChildren(h('p',{text:'读取中…'}));
  try {
    const response=await fetch('/api/gateway/recalls?identity='+encodeURIComponent(identity),{headers:{authorization:'Bearer '+el('key').value}});
    const data=await response.json();if(!response.ok)throw Error(data.error||response.status);
    if(revision!==recallRevision)return;
    const reasonText=reason=>({selector_not_configured:'尚未配置召回判断模型',latest_requires_selector:'需要判断事件先后，请配置召回判断模型',selector_timeout:'判断超时，聊天照常继续',selector_invalid_response:'判断模型返回了无法验证的结果',selector_incomplete_response:'判断模型的回答不完整',duplicate_content:'同一内容只保留一份',already_visible:'聊天历史里已经有了',item_budget:'已选出更合适的记忆',candidate_budget:'超过本次候选数量',no_lexical_support:'简单筛选没有找到对应词语',lexical_fallback_selected:'简单筛选找到了相关词语',empty_content:'没有可用正文'}[reason]||reason);
    const labels={semantic:'模型判断',lexical:'简单词面筛选',empty:'没有候选',error:'判断失败，本轮不注入'};
    const box=el('recallHistory');box.replaceChildren();
    for(const item of data.items){
      const selection=item.selection||{};
      const card=h('div',{class:'card'},h('h3',{text:item.query||'本轮'}),h('p',{text:item.created_at+' · '+(labels[selection.status]||'旧版召回')+' · 注入 '+item.injected+' 条'}));
      if(selection.reason)card.append(h('p',{text:reasonText(selection.reason)}));
      for(const decision of item.decisions||[]){
        const detail=h('details',{},h('summary',{text:(decision.injected?'已选 · ':'未选 · ')+reasonText(decision.reason||'')}));
        if(decision.excerpt)detail.append(h('p',{text:decision.excerpt}));
        detail.append(h('p',{class:'hint',text:(decision.namespace||'')+' / '+(decision.id||decision.kind||'')}));card.append(detail);
      }
      box.append(card);
    }
    if(!data.items.length)box.append(h('p',{text:'还没有召回记录。'}));
  }catch(error){if(revision===recallRevision)el('recallHistory').replaceChildren(h('p',{text:error.message}))}
};
</script></body></html>`;
