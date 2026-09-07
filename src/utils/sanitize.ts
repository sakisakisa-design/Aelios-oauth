import type { OpenAIChatMessage } from "../types";

const ENVELOPE_TAG_RE = /<([a-z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const ENVELOPE_MARKER_RE = /\b(?:from|sender|sender_id|msg_id|message_id)\s*=/i;

function decodeBasicEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ({
    "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'"
  })[entity] || entity);
}

/**
 * Some clients wrap the human sentence in a transport envelope such as
 * `<message from="hash" msg_id="123">hello</message>`. The attributes are
 * useful to the client, but poison lexical search and should never become the
 * remembered sentence. Only unwrap a complete, recognisable envelope; normal
 * prose and code samples stay untouched.
 */
export function cleanMessageText(input: string): string {
  let text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const bodies: string[] = [];
  let cursor = 0;
  ENVELOPE_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(ENVELOPE_TAG_RE)) {
    const index = match.index ?? 0;
    if (text.slice(cursor, index).trim()) { bodies.length = 0; break; }
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (!(tag.includes("message") && ENVELOPE_MARKER_RE.test(attrs))) { bodies.length = 0; break; }
    bodies.push(decodeBasicEntities(match[3]).trim());
    cursor = index + match[0].length;
  }
  if (bodies.length && !text.slice(cursor).trim()) {
    text = bodies.filter(Boolean).join("\n");
  }

  // A few bridges use a one-line header instead of XML. Require both sender
  // and message-id markers on that line to avoid eating ordinary prose.
  const newline = text.indexOf("\n");
  if (newline > 0) {
    const header = text.slice(0, newline);
    if (/\b(?:from|sender|sender_id)\s*[:=]/i.test(header) &&
        /\b(?:msg_id|message_id)\s*[:=]/i.test(header)) {
      text = text.slice(newline + 1).trim();
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract plain text from OpenAI-style message content (string or text parts array).
 * inject.ts and blocks.ts implementations are equivalent; blocks.ts uses explicit casts
 * for the array branch — behavior is identical for valid OpenAIChatMessage content.
 */
export function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

export function sanitizeMemoryContent(text: string): string {
  return cleanMessageText(text)
    .replace(/debug-test/gi, "")
    .replace(/记忆系统/g, "")
    .replace(/自动记忆测试口令/g, "口令")
    .replace(/测试口令/g, "口令")
    .replace(/标签为?[^，。；\s]+/g, "")
    .replace(/标签[:：]?[^，。；\s]+/g, "")
    .replace(/[，,；;：:]\s*([。.!！?？])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[，,；;：:\s]+|[，,；;：:\s]+$/g, "")
    .trim();
}

/** filter.ts superset: four summary-specific rules, then base sanitize. */
export function sanitizeSummaryContent(text: string): string {
  return sanitizeMemoryContent(
    text
      .replace(/<time_reminder>[^|。\n]*/gi, "")
      .replace(/对话摘要（\d+ 条消息）：?/g, "")
      .replace(/用户话题[:：]/g, "")
      .replace(/助手要点[:：]/g, "")
  );
}
