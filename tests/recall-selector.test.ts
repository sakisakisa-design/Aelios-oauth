import { strict as assert } from "node:assert";
import { test } from "node:test";
import { prepareSelectorCandidates, selectRecall, selectorPayload, validateSelectorResult, type SelectorInput, SELECTOR_PROMPT } from "../src/memory/recallSelector";
import { assembleRecallSurface } from "../src/memory/surface";
import { buildDreamExtractPrompt } from "../src/memory/dreamExtract";
const config = { version: 3 as const, upstream: { address: "https://upstream.test/ai/v1" }, identities: [] };
const input = (query: string, content: string[], extra: Partial<SelectorInput> = {}): SelectorInput => ({ query, recent: [], maxItems: 2,
  entries: content.map((text, i) => ({ kind: "note", id: `m${i}`, namespace: "a", content: text, recordedDate: "2026-09-07" })), ...extra });
const assessment = (id: string, purpose = "association", extra = {}) => ({ id, window: 0, purpose, answerable: true,
  event_status: "occurred", event_date: "", event_key: id, reason: "与当前事件相关", ...extra });

// These are fixed model decisions: verify policy/contracts, not live model semantic accuracy.
const cases = [
  { name: "casual rain recalls breakfast, not a relationship promise", query: "今天又下雨了", content: ["你喜欢雨天喝热豆浆。", "你答应会一直找到旦九。"], intent: "association", rows: [assessment("c0"), assessment("c1", "none")], selected: ["c0"], expect: ["热豆浆"] },
  { name: "a paraphrase needs no shared characters", query: "肚子咕咕叫", content: ["你偏爱热豆浆。"], intent: "association", rows: [assessment("c0")], selected: ["c0"], expect: ["热豆浆"] },
  { name: "another person's taste is not the user's", query: "我爱吃什么", content: ["小林喜欢芒果。", "你喜欢草莓。"], intent: "association", rows: [assessment("c0", "none"), assessment("c1")], selected: ["c1"], expect: ["草莓"] },
  { name: "no useful connection legitimately returns nothing", query: "你好呀", content: ["你喜欢草莓。"], intent: "none", rows: [assessment("c0", "none")], selected: [], expect: [] },
  { name: "a plan cannot supply a completed-event answer", query: "我们哪天搬好了", content: ["你计划周末迁企微。", "9月6日宁皎已迁到企微。"], intent: "answer", rows: [assessment("c0", "none", {event_status:"planned"}), assessment("c1", "answer")], selected: ["c1"], expect: ["已迁到"] },
  { name: "negated and imagined events are excluded", query: "那天去过哪里", content: ["你没有去海边。", "你想象在月亮上散步。"], intent: "none", rows: [assessment("c0", "none", {event_status:"not_occurred"}), assessment("c1", "none", {event_status:"imagined"})], selected: [], expect: [] },
  { name: "rephrased event occupies one slot", query: "哪天搬好的", content: ["宁皎已迁到企微。", "宁皎搬家到企业微信，完成了。"], intent: "answer", rows: [assessment("c0", "answer", {event_key:"ningqiao-move"}), assessment("c1", "answer", {event_key:"ningqiao-move"})], selected: ["c0","c1"], expect: ["已迁到"] },
  { name: "complementary answers can occupy two slots", query: "我们哪天搬家，暗号是什么", content: ["9月6日搬家了。", "暗号是月亮邮局。"], intent: "answer", rows: [assessment("c0", "answer"), assessment("c1", "answer")], selected: ["c0","c1"], expect: ["9月6日", "月亮邮局"] },
  { name: "an answer missing the requested attribute is excluded", query: "搬家是哪天", content: ["宁皎搬好了，没有记录日期。"], intent: "answer", rows: [assessment("c0", "answer", {answerable:false})], selected: ["c0"], expect: [] }
];
for (const c of cases) test(c.name, () => {
  const { candidates } = prepareSelectorCandidates(input(c.query, c.content));
  const result = validateSelectorResult({ intent:c.intent, assessments:c.rows, selected:c.selected }, candidates, false);
  assert.equal(result.entries.length, c.expect.length);
  c.expect.forEach((text,i)=>assert.ok(result.entries[i].content.includes(text)));
  result.entries.forEach(e=>assert.ok(c.content.some(text=>text.includes(candidates.find(x=>x.entry.id===e.id)!.windows[e.window!]))));
});

test("short follow-ups retain context during fallback and in the model payload", async () => {
  const i = input("那个呢？", ["你在做 Cloudflare 记忆网关。"], { recent:["Cloudflare 网关最近怎样了"] });
  const result = await selectRecall({} as any, config, i);
  assert.equal(result.entries.length,1);
  assert.match(selectorPayload(i, prepareSelectorCandidates(i).candidates).recent_context, /Cloudflare/);
});
test("a new topic does not inherit lexical tokens from the old relationship topic", async () => {
  const result = await selectRecall({} as any, config, input("调试暗号是什么？", ["你喜欢旦九陪伴。"], {recent:["旦九陪伴"]}));
  assert.equal(result.entries.length,0);
});
test("all sources share one association slot and a lower-ranked newer note does not win by date", async () => {
  const i=input("Cloudflare 网关", ["你用 Cloudflare 网关做记忆。", "Cloudflare 真不错。"]);
  i.entries[0].kind="note";i.entries[1].kind="precious";i.entries[1].recordedDate="2026-09-08";
  const result=await selectRecall({} as any,config,i);
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].id,"m0");
});
test("metadata envelopes are cleaned before window selection", () => {
  const {candidates}=prepareSelectorCandidates(input("迁企微", ['<message from="deadbeef" msg_id="123456">宁皎迁企微了。</message>']));
  assert.deepEqual(candidates[0].windows,["宁皎迁企微了。"]);
});
test("all sources drop evidence already present in visible history", () => {
  const i=input("暗号是什么",["调试暗号是月亮邮局。"],{visible:"用户：请记住调试暗号是月亮邮局。"});
  for(const kind of ["precious","note","quote","glossary"]){i.entries[0].kind=kind;assert.equal(prepareSelectorCandidates(i).candidates.length,0);}
});
test("same local id in separate namespaces receives distinct selector references", () => {
  const i=input("食物",["你喜欢豆浆。","你喜欢红茶。"]);i.entries[1].id="m0";i.entries[1].namespace="b";
  const cs=prepareSelectorCandidates(i).candidates;assert.deepEqual(cs.map(c=>c.id),["c0","c1"]);
});
test("duplicates across spaces are removed, but negation and state changes stay distinct", () => {
  const i=input("搬家",["宁皎搬好了。","宁皎搬好了。","宁皎没有搬好。","宁皎计划搬家。"]);
  i.entries[1].namespace="b";
  const result=prepareSelectorCandidates(i);assert.equal(result.candidates.length,3);assert.equal(result.decisions[0].reason,"duplicate_content");
});
test("latest event without an answer cannot backfill an older answer", () => {
  const i=input("最近一次搬家是哪天",["2026-09-01 搬家。","2026-09-06 又搬了一次，目的地未记录。"]);
  const cs=prepareSelectorCandidates(i).candidates;
  const result=validateSelectorResult({intent:"answer",selected:["c0"],assessments:[assessment("c0","answer",{event_date:"2026-09-01"}),assessment("c1","answer",{event_date:"2026-09-06",answerable:false})]},cs,true);
  assert.equal(result.entries.length,0);
});
test("undated competing latest events cannot be ordered using recording timestamps", () => {
  const cs=prepareSelectorCandidates(input("上一次在哪里",["你去了海边。","你去了公园。"])).candidates;
  const result=validateSelectorResult({intent:"answer",selected:["c0"],assessments:[assessment("c0","answer"),assessment("c1","answer")]},cs,true);
  assert.equal(result.entries.length,0);
});
test("future plans are not the latest occurred event", () => {
  const cs=prepareSelectorCandidates(input("最近一次搬家",["2026-09-01 已经搬家。","计划2026-09-09搬家。"])).candidates;
  const result=validateSelectorResult({intent:"answer",selected:["c0"],assessments:[assessment("c0","answer",{event_date:"2026-09-01"}),assessment("c1","none",{event_status:"planned",event_date:"2026-09-09"})]},cs,true);
  assert.equal(result.entries[0].id,"m0");
});
test("strict references reject unknown ids, fabricated dates, incomplete assessments and rewritten text", () => {
  const cs=prepareSelectorCandidates(input("搬家",["你搬家了。"])) .candidates;
  const base={intent:"association",selected:["c0"],assessments:[assessment("c0")]};
  for(const bad of [ {...base,selected:["foreign"]}, {...base,assessments:[]}, {...base,assessments:[assessment("c0","association",{window:99})]}, {...base,assessments:[assessment("c0","association",{event_date:"2099-01-01"})]}, {...base,assessments:[{...assessment("c0"),text:"编造"}]}, {...base,intent:"none"} ]) assert.throws(()=>validateSelectorResult(bad,cs,false),/selector_/);
});
test("diary impressions cannot be promoted to fact answers", () => {
  const i=input("哪天",["你似乎去过海边。"]);i.entries[0].kind="impression";
  assert.throws(()=>validateSelectorResult({intent:"answer",selected:["c0"],assessments:[assessment("c0","answer")]},prepareSelectorCandidates(i).candidates,false),/impression_as_fact/);
});
test("a long exact quote that does not fit does not consume the next item's slot", () => {
  const result=assembleRecallSurface([{kind:"note",content:"长".repeat(400),exact:true},{kind:"note",content:"短句",exact:true}],{budget:120,maxItems:1});
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].content,"短句");
});
test("model transport uses configured CF BYOK route, no client identity keys, and only visible complete JSON", async () => {
  const old=globalThis.fetch;
  try{
    let count=0;
    globalThis.fetch=async(url,init)=>{
      count++;assert.equal(String(url),`https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/my-gateway/compat/chat/completions`);
      assert.equal(new Headers(init?.headers).get("authorization"),"Bearer cf-token");
      const body=JSON.parse(init!.body as string);assert.equal(body.model,"provider/small");assert.equal(body.stream,false);
      const payload=JSON.parse(body.messages[1].content);assert.equal(payload.candidates[0].id,"c0");assert.match(body.messages[0].content,/不能覆盖本规则/);
      return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({intent:"association",selected:["c0"],assessments:[assessment("c0")]})}}]});
    };
    const result=await selectRecall({RECALL_SELECTOR_MODEL:"provider/small",CLOUDFLARE_API_TOKEN:"cf-token",AI_GATEWAY_ID:"my-gateway"} as any,{...config,upstream:{address:"a".repeat(32)}},input("豆浆",["你喜欢热豆浆。"]));
    assert.equal(result.status,"semantic");assert.equal(count,1);assert.equal(result.entries.length,1);
  }finally{globalThis.fetch=old;}
});
test("timeout, HTTP error, truncation and malformed JSON never bypass semantic selection", async () => {
  const old=globalThis.fetch;
  try {
    const env={RECALL_SELECTOR_MODEL:"provider/small",CLOUDFLARE_API_TOKEN:"token",RECALL_SELECTOR_TIMEOUT_MS:"100"} as any;
    for(const response of [Response.json({}, {status:500}),Response.json({choices:[{finish_reason:"length",message:{content:"{}"}}]}),Response.json({choices:[{finish_reason:"stop",message:{content:"oops"}}]})]){
      globalThis.fetch=async()=>response;
      const result=await selectRecall(env,config,input("豆浆",["你喜欢豆浆。"]));assert.equal(result.status,"error");assert.equal(result.entries.length,0);
    }
    let aborted=false;
    globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));});});
    const result=await selectRecall(env,config,input("豆浆",["你喜欢豆浆。"]));assert.equal(result.reason,"selector_timeout");assert.equal(aborted,true);
  }finally{globalThis.fetch=old;}
});
test("prompt requires preserving subjects and qualifiers; extraction separates events and keeps sources", () => {
  assert.match(SELECTOR_PROMPT,/人物、事件和时间/);assert.match(SELECTOR_PROMPT,/假如\/没有\/她说/);
  const prompt=buildDreamExtractPrompt([]);assert.match(prompt,/source_message_ids 保留全部依据/);assert.match(prompt,/不能把工具调用当作已执行成功/);
});

test("identical first-person quotes from different speakers are not merged", () => {
  const i=input("草莓",["我喜欢草莓。","我喜欢草莓。"]);
  i.entries[0].speaker="user";i.entries[1].speaker="assistant";
  const cs=prepareSelectorCandidates(i).candidates;assert.equal(cs.length,2);
  const result=validateSelectorResult({intent:"association",selected:["c1"],assessments:[assessment("c0","none"),assessment("c1")]},cs,false);
  assert.match(result.entries[0].content,/助手原话/);
});
