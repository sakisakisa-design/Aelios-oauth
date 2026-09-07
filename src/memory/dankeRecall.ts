// Exact-span recall from 蛋壳 / 墨安 2026-09-07 (recall_core.py, function bodies ported).
// Similarity only nominates candidates. Injection quotes a numbered window from stored text.

export const EVENT_STATUSES = ["unrelated", "planned", "not_occurred", "imagined", "occurred"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type RecallIntent = "none" | "answer" | "association";
export type AssessmentPurpose = "none" | "redundant" | "answer" | "association";

export interface RecallCandidate {
  id: string;
  windows: string[];
  recorded_date?: string;
  event_date?: string;
}

export interface SelectedSpan {
  id: string;
  purpose: "answer" | "association";
  window: number;
}

const ARCHIVE_HEADER = /^【对话归档\s+v\d+\s+[^】]*】$/;
const SECTION_LABEL = /^(?:摘要|事实|原话|情绪)[：:]?$/;

function isAlnum(ch: string): boolean {
  return /\p{L}|\p{N}/u.test(ch);
}

function parseIsoDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ts = Date.parse(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function ymd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1000 || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Bounded exact source spans. Lexical overlap ranks long-record windows; it never admits a memory. */
export function evidenceWindows(content: string, query: string, limit = 12): string[] {
  const source = String(content || "");
  if (!source) return [];
  const units = [...source.matchAll(/[^\n。！？；]+(?:[。！？；]+|\n|$)/g)]
    .map((match) => match[0].trim())
    .filter(Boolean)
    .filter((unit) => !ARCHIVE_HEADER.test(unit) && !SECTION_LABEL.test(unit));
  const chunks: string[] = [];
  for (const unit of units) {
    for (let i = 0; i < unit.length; i += 350) chunks.push(unit.slice(i, i + 400));
  }
  if (source.length <= 2400 || chunks.length <= limit) return chunks;

  const clean = [...query.toLowerCase()].filter(isAlnum).join("");
  const terms = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) terms.add(clean.slice(i, i + 2));
  const scores = chunks.map((chunk) => {
    const lower = chunk.toLowerCase();
    let hits = 0;
    for (const term of terms) if (lower.includes(term)) hits += 1;
    return hits;
  });
  const indices = new Set<number>([0, chunks.length - 1]);
  if (terms.size && Math.max(...scores) > 0) {
    const ranked = scores.map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const row of ranked) {
      indices.add(row.index);
      if (indices.size === limit) break;
    }
  } else {
    for (let i = 0; i < limit; i++) {
      indices.add(Math.round(i * (chunks.length - 1) / (limit - 1)));
    }
  }
  return [...indices].sort((a, b) => a - b).map((index) => chunks[index]);
}

/** Constrain model event dates to dates grounded in record metadata/text. */
export function dateOptions(candidate: RecallCandidate): string[] {
  const values = new Set<string>();
  const recorded = String(candidate.recorded_date || "").slice(0, 10);
  const recordedYmd = ymd(Number(recorded.slice(0, 4)), Number(recorded.slice(5, 7)), Number(recorded.slice(8, 10)));
  const anchor = recordedYmd ? parseIsoDate(`${recordedYmd}T00:00:00Z`) : null;
  if (recordedYmd) values.add(recordedYmd);
  const event = String(candidate.event_date || "").slice(0, 10);
  const eventYmd = ymd(Number(event.slice(0, 4)), Number(event.slice(5, 7)), Number(event.slice(8, 10)));
  if (eventYmd) values.add(eventYmd);
  const content = (candidate.windows || []).join("\n");
  for (const [, year, month, day] of content.matchAll(/(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/g)) {
    const parsed = ymd(Number(year), Number(month), Number(day));
    if (parsed) values.add(parsed);
  }
  if (anchor && recordedYmd) {
    for (const [, month, day] of content.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日/g)) {
      const parsed = ymd(anchor.getUTCFullYear(), Number(month), Number(day));
      if (parsed) values.add(parsed);
    }
    const offsets: Array<[string, number]> = [["昨天", 1], ["昨日", 1], ["昨晚", 1], ["前天", 2], ["大前天", 3]];
    for (const [word, days] of offsets) {
      if (content.includes(word)) {
        const shifted = new Date(anchor.getTime() - days * 86400000);
        const parsed = ymd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
        if (parsed) values.add(parsed);
      }
    }
  }
  return [...values].sort();
}

function keysOf(value: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(value));
}

function sameKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = keysOf(value);
  return keys.size === expected.length && expected.every((key) => keys.has(key));
}

/** Validate references, then rank occurred events before testing answerability. */
export function resolveSelection(
  parsed: Record<string, unknown>,
  candidates: RecallCandidate[],
  latestRequired: boolean
): SelectedSpan[] {
  if (!sameKeys(parsed, ["intent", "selected", "timeline"])) throw new Error("selector_invalid_schema");
  const intent = parsed.intent;
  if (intent !== "none" && intent !== "answer" && intent !== "association") throw new Error("selector_invalid_intent");
  if (intent === "none") {
    if (!Array.isArray(parsed.selected) || parsed.selected.length || !Array.isArray(parsed.timeline) || parsed.timeline.length) {
      throw new Error("selector_intent_conflict");
    }
    return [];
  }
  const selected = parsed.selected;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  if (!Array.isArray(selected) || selected.length > 2) throw new Error("selector_invalid_count");
  const seen = new Set<string>();
  const items: Array<SelectedSpan & { answerable: boolean }> = [];
  for (const item of selected) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !sameKeys(item as Record<string, unknown>, ["id", "purpose", "window", "answerable"])) {
      throw new Error("selector_invalid_item");
    }
    const row = item as { id: unknown; purpose: unknown; window: unknown; answerable: unknown };
    const mid = row.id;
    if (typeof mid !== "string" || !byId.has(mid) || seen.has(mid)) throw new Error("selector_invalid_id");
    if (row.purpose !== "answer" && row.purpose !== "association") throw new Error("selector_invalid_purpose");
    if (row.purpose !== intent) throw new Error("selector_intent_conflict");
    if (typeof row.answerable !== "boolean") throw new Error("selector_invalid_answerability");
    const index = row.window;
    const windows = byId.get(mid)!.windows;
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= windows.length) throw new Error("selector_invalid_window");
    seen.add(mid);
    items.push({ id: mid, purpose: row.purpose, window: Number(index), answerable: row.answerable });
  }
  const timeline = parsed.timeline;
  if (!Array.isArray(timeline)) throw new Error("selector_invalid_timeline");
  if (!latestRequired || intent !== "answer") {
    if (timeline.length) throw new Error("selector_unrequested_timeline");
    return items.filter((item) => item.purpose === "association" || item.answerable)
      .map(({ id, purpose, window }) => ({ id, purpose, window }));
  }
  if (timeline.length !== candidates.length) throw new Error("selector_incomplete_timeline");
  const seenTimeline = new Set<string>();
  const occurred: Array<[string, string, number, boolean]> = [];
  for (const row of timeline) {
    if (!Array.isArray(row) || row.length !== 5) throw new Error("selector_invalid_timeline_row");
    const [mid, status, window, date, answerable] = row as unknown[];
    if (typeof mid !== "string" || !byId.has(mid) || seenTimeline.has(mid)) throw new Error("selector_invalid_timeline_id");
    seenTimeline.add(mid);
    if (typeof status !== "string" || !EVENT_STATUSES.includes(status as EventStatus) || typeof answerable !== "boolean") {
      throw new Error("selector_invalid_event_status");
    }
    const windows = byId.get(mid)!.windows;
    if (!Number.isInteger(window) || Number(window) < 0 || Number(window) >= windows.length) throw new Error("selector_invalid_event_window");
    if (typeof date !== "string" || (date && !dateOptions(byId.get(mid)!).includes(date))) {
      throw new Error("selector_ungrounded_event_date");
    }
    if (status === "occurred") occurred.push([date, mid, Number(window), answerable]);
  }
  if (!occurred.length) return [];
  if (occurred.length > 1 && occurred.some((row) => !row[0])) return [];
  occurred.sort((a, b) => b[0].localeCompare(a[0]));
  const top = occurred.filter((row) => row[0] === occurred[0][0]);
  let chosen = top[0];
  if (top.length > 1) {
    const tied = items.map((item) => top.find((row) => item.id === row[1])).find(Boolean);
    if (!tied) return [];
    chosen = tied;
  }
  const [, mid, window, answerable] = chosen;
  if (!answerable) return [];
  return [{ id: mid, purpose: "answer", window }];
}

/** Every candidate is judged before a global empty decision is admitted. */
export function resolveAssessedSelection(
  parsed: Record<string, unknown>,
  candidates: RecallCandidate[],
  latestRequired: boolean
): SelectedSpan[] {
  if (!sameKeys(parsed, ["assessments", "intent", "selected", "timeline"])) throw new Error("selector_invalid_schema");
  const rows = parsed.assessments;
  if (!Array.isArray(rows) || rows.length !== candidates.length) throw new Error("selector_incomplete_assessments");
  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const assessed = new Map<string, AssessmentPurpose>();
  const assessedWindows = new Map<string, number>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3) throw new Error("selector_invalid_assessment");
    const [mid, purpose, window] = row as unknown[];
    if (typeof mid !== "string" || !known.has(mid) || assessed.has(mid)) throw new Error("selector_invalid_assessment_id");
    if (purpose !== "none" && purpose !== "redundant" && purpose !== "answer" && purpose !== "association") {
      throw new Error("selector_invalid_assessment_purpose");
    }
    const windows = known.get(mid)!.windows;
    if (!Number.isInteger(window) || Number(window) < 0 || Number(window) >= windows.length) {
      throw new Error("selector_invalid_assessment_window");
    }
    assessed.set(mid, purpose);
    assessedWindows.set(mid, Number(window));
  }
  const selected = resolveSelection(
    { intent: parsed.intent, selected: parsed.selected, timeline: parsed.timeline },
    candidates,
    latestRequired
  );
  if (parsed.intent === "none" && [...assessed.values()].some((purpose) => purpose === "answer" || purpose === "association")) {
    throw new Error("selector_assessment_conflict");
  }
  for (const item of selected) {
    if (assessed.get(item.id) !== item.purpose) throw new Error("selector_assessment_conflict");
  }
  if (parsed.intent === "association") {
    return [...assessed.entries()]
      .filter(([, purpose]) => purpose === "association")
      .map(([id, purpose]) => ({ id, purpose: purpose as "association", window: assessedWindows.get(id)! }));
  }
  return selected;
}

/** Choose one admitted association. This is not event chronology for answers. */
export function chooseAssociation(selected: SelectedSpan[], candidates: RecallCandidate[]): SelectedSpan[] {
  if (!selected.length || selected.some((item) => item.purpose !== "association")) return selected;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ranks = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const stamp = (item: SelectedSpan): number => {
    const recorded = String(byId.get(item.id)?.recorded_date || "");
    const parsed = parseIsoDate(recorded);
    return parsed ? parsed.getTime() : Number.NEGATIVE_INFINITY;
  };
  return [selected.reduce((best, item) => {
    const left = stamp(item);
    const right = stamp(best);
    if (left !== right) return left > right ? item : best;
    return (ranks.get(item.id) ?? 0) < (ranks.get(best.id) ?? 0) ? item : best;
  })];
}

function queryBigrams(query: string): Set<string> {
  const clean = [...query.toLowerCase()].filter(isAlnum).join("");
  const terms = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) terms.add(clean.slice(i, i + 2));
  return terms;
}

export function windowOverlapScore(window: string, query: string): number {
  const terms = queryBigrams(query);
  if (!terms.size) return 0;
  const lower = window.toLowerCase();
  let score = 0;
  for (const term of terms) if (lower.includes(term)) score += 1;
  return score;
}

export function pickWindowIndex(windows: string[], query: string): number {
  if (windows.length <= 1) return 0;
  let best = 0;
  let bestScore = -1;
  windows.forEach((window, index) => {
    const score = windowOverlapScore(window, query);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

export function formatExactExcerpt(excerpt: string, purpose: "answer" | "association"): string {
  const label = purpose === "answer" ? "回答旧事" : "相关旧事，可自然提及，不作当前事实";
  return `${label}：「${excerpt.replace(/\n/g, " ↩ ")}」`;
}

/** Slice admitted memories into windows and pick exact spans. Empty is a valid result. */
export function excerptAdmittedMemories(
  hits: Array<{ id: string; content: string; recorded_date?: string | null }>,
  query: string,
  purpose: "answer" | "association"
): Array<SelectedSpan & { excerpt: string }> {
  const candidates: RecallCandidate[] = [];
  const admitted: SelectedSpan[] = [];
  for (const hit of hits) {
    const windows = evidenceWindows(hit.content, query);
    if (!windows.length) continue;
    const window = pickWindowIndex(windows, query);
    // Recency must not admit a memory the current line does not support.
    if (windowOverlapScore(windows[window], query) <= 0) continue;
    candidates.push({
      id: hit.id,
      windows,
      ...(hit.recorded_date ? { recorded_date: hit.recorded_date } : {})
    });
    admitted.push({ id: hit.id, purpose, window });
  }
  if (!candidates.length) return [];
  const selected = purpose === "association" ? chooseAssociation(admitted, candidates) : admitted.slice(0, 2);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return selected.map((item) => {
    const excerpt = byId.get(item.id)!.windows[item.window];
    return { ...item, excerpt };
  }).filter((item) => item.excerpt);
}
