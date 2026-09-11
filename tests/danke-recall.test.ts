import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evidenceWindows, formatExactExcerpt } from "../src/memory/dankeRecall";
import { assembleRecallSurface } from "../src/memory/surface";

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

test("exact surface keeps the stored sentence instead of chopping it", () => {
  const excerpt = formatExactExcerpt("用户说，下雨天喜欢喝热豆浆。", "association");
  const assembled = assembleRecallSurface([
    { kind: "note", content: excerpt, exact: true, window: 1, purpose: "association" }
  ], { budget: 6000, maxItems: 2, maxChars: 20 });
  assert.match(assembled.text, /下雨天喜欢喝热豆浆/);
  assert.doesNotMatch(assembled.text, /memory_id|demo01/);
});
