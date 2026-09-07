// Bounded exact source spans. Lexical overlap only nominates windows.

const ARCHIVE_HEADER = /^【对话归档\s+v\d+\s+[^】]*】$/;
const SECTION_LABEL = /^(?:摘要|事实|原话|情绪)[：:]?$/;

function isAlnum(ch: string): boolean {
  return /\p{L}|\p{N}/u.test(ch);
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

export function formatExactExcerpt(excerpt: string, purpose: "answer" | "association"): string {
  const label = purpose === "answer" ? "回答旧事" : "相关旧事，可自然提及，不作当前事实";
  return `${label}：「${excerpt.replace(/\n/g, " ↩ ")}」`;
}
