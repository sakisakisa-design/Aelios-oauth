import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chooseAssociation,
  evidenceWindows,
  excerptAdmittedMemories,
  formatExactExcerpt,
  resolveAssessedSelection,
  resolveSelection
} from "../src/memory/dankeRecall";
import { assembleRecallSurface } from "../src/memory/surface";

function demo() {
  const message = "今天又下雨了，买杯豆浆。";
  const records = {
    demo01: {
      id: "demo01",
      recorded_date: "2026-09-01T09:00:00+08:00",
      content: "摘要：用户聊了雨天早餐。\n事实：\n用户说，下雨天喜欢喝热豆浆。"
    },
    demo02: {
      id: "demo02",
      recorded_date: "2026-09-02T09:00:00+08:00",
      content: "事实：\n用户计划周末买雨伞，还没有去。"
    }
  };
  const candidates = Object.values(records).map((row) => ({
    id: row.id,
    recorded_date: row.recorded_date,
    windows: evidenceWindows(row.content, message)
  }));
  const admitted = resolveAssessedSelection({
    intent: "association",
    selected: [],
    timeline: [],
    assessments: [["demo01", "association", 1], ["demo02", "none", 0]]
  }, candidates, false);
  const selected = chooseAssociation(admitted, candidates);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const excerpts = selected.map((item) => byId.get(item.id)!.windows[item.window]);
  return { selected, excerpts };
}

test("demo returns the exact stored sentence", () => {
  const result = demo();
  assert.deepEqual(result.excerpts, ["用户说，下雨天喜欢喝热豆浆。"]);
  assert.equal(result.selected[0].id, "demo01");
});

test("long units stay bounded, exact, and overlapping", () => {
  const source = "甲".repeat(950);
  const windows = evidenceWindows(source, "甲");
  assert.ok(windows.every((window) => source.includes(window) && window.length <= 400));
  assert.deepEqual(windows.map((window) => window.length), [400, 400, 250]);
  assert.equal(windows[0].slice(-50), windows[1].slice(0, 50));
});

test("large archive keeps first, last, and twelve windows", () => {
  const units = Array.from({ length: 25 }, (_, i) => `第${i}项${"资料".repeat(90)}。`);
  const source = units.join("");
  const windows = evidenceWindows(source, "无匹配");
  assert.equal(windows.length, 12);
  assert.equal(windows[0], units[0]);
  assert.equal(windows.at(-1), units.at(-1));
  assert.ok(windows.every((window) => source.includes(window)));
});

test("bad window is rejected", () => {
  const candidates = [
    { id: "a", recorded_date: "2026-09-01", windows: ["旧记录。"] },
    { id: "b", recorded_date: "2026-09-02", windows: ["新记录。"] }
  ];
  assert.throws(
    () => resolveAssessedSelection({
      intent: "association",
      selected: [],
      timeline: [],
      assessments: [["a", "association", 9], ["b", "none", 0]]
    }, candidates, false),
    /invalid_assessment_window/
  );
});

test("empty intent cannot hide a qualified candidate", () => {
  const candidates = [
    { id: "a", recorded_date: "2026-09-01", windows: ["旧记录。"] },
    { id: "b", recorded_date: "2026-09-02", windows: ["新记录。"] }
  ];
  assert.throws(
    () => resolveAssessedSelection({
      intent: "none",
      selected: [],
      timeline: [],
      assessments: [["a", "association", 0], ["b", "none", 0]]
    }, candidates, false),
    /assessment_conflict/
  );
});

test("recency only orders already qualified associations", () => {
  const candidates = [
    { id: "a", recorded_date: "2026-09-01", windows: ["旧记录。"] },
    { id: "b", recorded_date: "2026-09-02", windows: ["新记录。"] }
  ];
  const old = { id: "a", purpose: "association" as const, window: 0 };
  const newer = { id: "b", purpose: "association" as const, window: 0 };
  assert.deepEqual(chooseAssociation([old], candidates), [old]);
  assert.deepEqual(chooseAssociation([old, newer], candidates), [newer]);
});

test("missing answer attribute is not an answer", () => {
  const candidates = [
    { id: "a", recorded_date: "2026-09-01", windows: ["旧记录。"] },
    { id: "b", recorded_date: "2026-09-02", windows: ["新记录。"] }
  ];
  assert.deepEqual(resolveSelection({
    intent: "answer",
    timeline: [],
    selected: [{ id: "a", purpose: "answer", window: 0, answerable: false }]
  }, candidates, false), []);
});

test("latest unknown does not backfill an older answer", () => {
  const candidates = [
    { id: "a", recorded_date: "2026-09-01", windows: ["旧记录。"] },
    { id: "b", recorded_date: "2026-09-02", windows: ["新记录。"] }
  ];
  assert.deepEqual(resolveSelection({
    intent: "answer",
    selected: [{ id: "a", purpose: "answer", window: 0, answerable: true }],
    timeline: [
      ["a", "occurred", 0, "2026-09-01", true],
      ["b", "occurred", 0, "2026-09-02", false]
    ]
  }, candidates, true), []);
});

test("newer unrelated record cannot beat a supported association", () => {
  const spans = excerptAdmittedMemories([
    {
      id: "demo01",
      recorded_date: "2026-09-01T09:00:00+08:00",
      content: "摘要：用户聊了雨天早餐。\n事实：\n用户说，下雨天喜欢喝热豆浆。"
    },
    {
      id: "demo02",
      recorded_date: "2026-09-02T09:00:00+08:00",
      content: "事实：\n用户计划周末买雨伞，还没有去。"
    }
  ], "今天又下雨了，买杯豆浆。", "association");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].id, "demo01");
});

test("auto excerpt picks one association sentence and labels it", () => {
  const spans = excerptAdmittedMemories([
    {
      id: "demo01",
      recorded_date: "2026-09-01T09:00:00+08:00",
      content: "摘要：用户聊了雨天早餐。\n事实：\n用户说，下雨天喜欢喝热豆浆。"
    },
    {
      id: "demo02",
      recorded_date: "2026-09-02T09:00:00+08:00",
      content: "事实：\n用户计划周末买雨伞，还没有去。"
    }
  ], "今天又下雨了，买杯豆浆。", "association");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].excerpt, "用户说，下雨天喜欢喝热豆浆。");
  assert.match(formatExactExcerpt(spans[0].excerpt, spans[0].purpose), /相关旧事.*下雨天喜欢喝热豆浆/);
});

test("exact surface keeps the stored sentence instead of chopping it", () => {
  const excerpt = formatExactExcerpt("用户说，下雨天喜欢喝热豆浆。", "association");
  const assembled = assembleRecallSurface([
    { kind: "note", content: excerpt, exact: true, window: 1, purpose: "association" }
  ], { budget: 6000, maxItems: 2, maxChars: 20 });
  assert.match(assembled.text, /下雨天喜欢喝热豆浆/);
  assert.doesNotMatch(assembled.text, /memory_id|demo01/);
});
