// Query shaping for recall. Inspired by LMC-5 / Hindsight:
// do not embed the last utterance alone when it is a thin continuation.

const STOP = new Set([
  "的", "了", "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "哈", "呵",
  "我", "你", "他", "她", "它", "们", "自己",
  "是", "在", "有", "和", "就", "都", "也", "还", "又", "很", "太", "更",
  "这", "那", "这个", "那个", "这些", "那些",
  "什么", "怎么", "怎样", "如何", "为什么", "为啥",
  "一下", "一点", "一些",
  "可以", "是否", "请", "帮", "帮我", "给我",
  "看看", "看一下", "说说", "讲讲",
  "继续", "然后", "还有", "以及", "或者", "如果", "因为", "所以",
  "我们", "你们", "他们",
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for",
  "and", "or", "but", "if", "this", "that", "these", "those", "it", "we", "you",
  "i", "me", "my", "your", "our", "with", "from", "as", "at", "by", "do", "did",
  "please", "help", "continue", "ok", "okay", "yes", "no", "hmm", "uh"
]);

// Function characters that should not seed a CJK bigram.
const CJK_FUNC = /[的了吗呢吧啊呀哦嗯呵哈我你他她它们是在有和就都也还这那什么怎为]/;

const THIN_RE =
  /^(那个|这个|继续|然后|好的|好|嗯|哦|啊|呢|吗|ok|okay|yes|continue|again|同上|还有呢|然后呢|接着|下一步)[\s?？!！.。]*$/i;

export interface ShapedQuery {
  original: string;
  embeddingQuery: string;
  lexicalTokens: string[];
  thin: boolean;
}

export function tokenizeQuery(text: string): string[] {
  const tokens = new Set<string>();
  const norm = text.toLowerCase();

  for (const word of norm.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (word.length >= 2 && !STOP.has(word)) tokens.add(word);
  }

  const chars = [...norm].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  for (let i = 0; i < chars.length - 1; i++) {
    if (CJK_FUNC.test(chars[i]) || CJK_FUNC.test(chars[i + 1])) continue;
    tokens.add(chars[i] + chars[i + 1]);
  }

  for (const run of norm.match(/[\u4e00-\u9fff]{2,6}/g) ?? []) {
    if (STOP.has(run)) continue;
    if (CJK_FUNC.test(run[0]) || CJK_FUNC.test(run[run.length - 1])) continue;
    tokens.add(run);
  }

  return [...tokens].slice(0, 12);
}

function collectIndexTokens(norm: string): string[] {
  const tokens = new Set<string>();

  for (const word of norm.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (word.length >= 2 && !STOP.has(word)) tokens.add(word);
  }

  const chars = [...norm].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  for (let i = 0; i < chars.length - 1; i++) {
    if (CJK_FUNC.test(chars[i]) || CJK_FUNC.test(chars[i + 1])) continue;
    tokens.add(chars[i] + chars[i + 1]);
  }

  for (const run of norm.match(/[\u4e00-\u9fff]{2,8}/g) ?? []) {
    if (STOP.has(run)) continue;
    if (CJK_FUNC.test(run[0]) || CJK_FUNC.test(run[run.length - 1])) continue;
    tokens.add(run);
  }

  for (const code of norm.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    if (code.length >= 2 && !STOP.has(code)) tokens.add(code);
  }

  return [...tokens];
}

export function tokenizeForIndex(text: string, limit = 80): string[] {
  const norm = text.toLowerCase();
  if (norm.length <= 480) return collectIndexTokens(norm).slice(0, limit);

  const head = collectIndexTokens(norm.slice(0, 480));
  const tail = collectIndexTokens(norm.slice(-480));
  const merged = [...new Set([...head, ...tail])];
  if (merged.length <= limit) return merged;
  const headKeep = Math.ceil(limit * 0.6);
  return [...new Set([...head.slice(0, headKeep), ...tail.slice(-(limit - headKeep))])].slice(0, limit);
}

export function isEvidenceQuery(query: string): boolean {
  return /最近一次|最后一次|上一次|last time|most recent|暗号|口令|原话|说过|怎么说的|哪天|几号|什么时候|何时|日期|passphrase|said|quote|when did|what did/i.test(query);
}

export function isTemporalQuery(query: string): boolean {
  return /这周|上周|本周|那周|最近一周|周记|这个月|上个月|日记|那天发生|这一周/i.test(query);
}

export function isThinQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (q.length <= 6) return true;
  if (THIN_RE.test(q)) return true;
  return tokenizeQuery(q).length === 0;
}

export function shapeRecallQuery(input: { query: string; recent?: string[] }): ShapedQuery {
  const original = input.query.trim();
  const recent = (input.recent ?? []).map((s) => s.trim()).filter(Boolean).slice(-3);
  const thin = isThinQuery(original);
  const context = recent.join("\n");
  const embeddingQuery = (thin && context ? `${context}\n${original}` : original).slice(-800);
  // Topical questions keep their own tokens. Mixing the last two turns here
  // was leaking the previous topic into precious / week / glossary selection.
  const lexicalSource = thin ? [original, ...recent.slice(-2)].join("\n") : original;
  const lexicalTokens = tokenizeQuery(lexicalSource);
  return { original, embeddingQuery, lexicalTokens, thin };
}

export function lexicalOverlapScore(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (token && lower.includes(token.toLowerCase())) hits += 1;
  }
  return hits / tokens.length;
}

export function overlappingTokens(text: string, tokens: string[]): string[] {
  const lower = text.toLowerCase();
  return tokens.filter((token) => token && lower.includes(token.toLowerCase()));
}

export function isDistinctiveToken(token: string): boolean {
  if (!token) return false;
  if (token.length >= 4) return true;
  if (token.length >= 3 && /^[a-z0-9]+$/i.test(token)) return true;
  return token.length >= 2 && /[\u4e00-\u9fff]/.test(token);
}

export function isPreciousRelevant(text: string, tokens: string[]): boolean {
  const hits = overlappingTokens(text, tokens);
  if (hits.length >= 2) return true;
  return hits.some(isDistinctiveToken);
}

export function selectRelevantPrecious<T extends { content: string }>(
  rows: T[],
  tokens: string[],
  options?: { limit?: number }
): T[] {
  const limit = options?.limit ?? 5;
  if (tokens.length === 0 || limit <= 0) return [];
  return rows
    .map((row) => ({ row, score: lexicalOverlapScore(row.content, tokens), hits: overlappingTokens(row.content, tokens) }))
    .filter((item) => item.score > 0 && isPreciousRelevant(item.row.content, tokens))
    .sort((a, b) => b.score - a.score || b.hits.length - a.hits.length || a.row.content.localeCompare(b.row.content))
    .slice(0, limit)
    .map((item) => item.row);
}

/** True overlap only. A single CJK bigram is not enough to keep a hit. */
export function hasLexicalSupport(text: string, tokens: string[]): boolean {
  const hits = overlappingTokens(text, tokens);
  if (hits.length >= 2) return true;
  return hits.some((token) => token.length >= 4 || (token.length >= 3 && /^[a-z0-9]+$/i.test(token)));
}

/**
 * Lexical channel score. The old formula `0.35 + (hits/n)*0.5` turned a 1-of-8
 * token scrape into 0.4125 — a padded floor that looked like cosine similarity.
 * Zero overlap is now 0; weak overlap stays below the recall floor.
 */
export function lexicalHitScore(content: string, query: string, tokens: string[]): number {
  const lower = content.toLowerCase();
  const queryLower = query.toLowerCase();
  const exact = queryLower.length >= 2 && lower.includes(queryLower) ? 0.15 : 0;
  if (tokens.length === 0) return exact ? 0.75 : 0;
  let hits = 0;
  for (const token of tokens) {
    if (token && lower.includes(token.toLowerCase())) hits += 1;
  }
  if (hits === 0) return exact;
  return Math.min(0.95, (hits / tokens.length) * 0.8 + exact);
}

export interface GroundedHitOptions {
  minScore?: number;
  strongScore?: number;
}

/**
 * Do not pad to topK. Keep a hit only if it is clearly similar, or it has
 * real lexical support above the garbage floor. Prefer three grounded rows
 * over ten centroid leftovers.
 */
export function keepGroundedHits<T extends { score: number; content: string }>(
  records: T[],
  tokens: string[],
  topK: number,
  options?: GroundedHitOptions
): T[] {
  const minScore = options?.minScore ?? 0.15;
  const strongScore = options?.strongScore ?? 0.5;
  const limit = Math.max(0, topK);
  if (limit === 0) return [];
  return records.filter((record) => {
    if (record.score >= strongScore) return true;
    return record.score >= minScore && hasLexicalSupport(record.content, tokens);
  }).slice(0, limit);
}

export function reciprocalRankScore(rank: number, k = 60): number {
  return 1 / (k + rank + 1);
}

export function mergeHybridRanks<T extends { id: string; score: number }>(
  vector: T[],
  lexical: T[],
  topK: number
): T[] {
  const rrf = new Map<string, number>();
  const byId = new Map<string, T>();

  const add = (list: T[], channelWeight = 1) => {
    list.forEach((record, index) => {
      rrf.set(record.id, (rrf.get(record.id) ?? 0) + reciprocalRankScore(index) * channelWeight);
      const existing = byId.get(record.id);
      if (!existing || record.score > existing.score) byId.set(record.id, record);
    });
  };

  add(vector);
  add(lexical);

  return [...byId.values()]
    .sort((a, b) => (rrf.get(b.id) ?? 0) - (rrf.get(a.id) ?? 0) || b.score - a.score)
    .slice(0, topK);
}
