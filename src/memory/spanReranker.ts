import type { Env } from "../types";

/** The score is model-specific relevance, not a probability that a memory is true. */
export function spanRerankerSettings(env: Env) {
  const raw = env.MEMORY_RERANKER_MODEL?.trim() || "@cf/baai/bge-reranker-base";
  const model = raw.replace(/^(?:workers-ai|worker)\//, "");
  const score = Number(env.RECALL_RERANK_MIN_SCORE?.trim() || "0.5");
  const ms = Number(env.RECALL_RERANK_TIMEOUT_MS?.trim() || "1500");
  return { model, threshold: Number.isFinite(score) ? score : 0.5,
    timeout: Number.isFinite(ms) ? Math.max(100, Math.min(5000, ms)) : 1500 };
}

/** One bounded Workers AI request; never fall back to unscored or generated text. */
export async function scoreRecallSpans(env: Env, query: string, texts: string[]) {
  const { model, timeout } = spanRerankerSettings(env);
  if (env.ENABLE_MEMORY_RERANKER === "false") throw new Error("reranker_disabled");
  if (!env.AI) throw new Error("reranker_missing_binding");
  if (!model.startsWith("@cf/")) throw new Error("reranker_unsupported_model");
  if (!texts.length || texts.length > 64) throw new Error("reranker_invalid_budget");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Binding calls have no AbortSignal: late results are discarded, not cancelled.
    const output: any = await Promise.race([
      env.AI.run(model as any, { query, contexts: texts.map(text => ({ text })), top_k: texts.length } as any),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reranker_timeout")), timeout); })
    ]);
    const rows = Array.isArray(output) ? output : output?.response ?? output?.result ?? output?.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("reranker_invalid_response");
    const seen = new Set<number>();
    const scores = new Array<number>(texts.length);
    for (const row of rows) {
      const id = row?.id ?? row?.index;
      if (!Number.isInteger(id) || id < 0 || id >= texts.length || seen.has(id) ||
          typeof row?.score !== "number" || !Number.isFinite(row.score)) throw new Error("reranker_invalid_response");
      seen.add(id); scores[id] = row.score;
    }
    return scores;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    throw new Error(/^reranker_[a-z_]+$/.test(reason) ? reason : "reranker_failed");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
