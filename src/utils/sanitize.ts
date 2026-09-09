import type { OpenAIChatMessage } from "../types";

const ENVELOPE_MARKER_RE = /\b(?:from|sender|sender_id|msg_id|message_id)\s*=/i;

function decodeBasicEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ({
    "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'"
  })[entity] || entity);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCloseTag(text: string, tag: string): boolean {
  return new RegExp(`</${escapeRegExp(tag)}\\s*>`, "i").test(text);
}

/**
 * Transport wrappers (企微 / IM bridges). Keep the inner sentence; never
 * remember hashes or msg_id attributes. A bare `<message>` without sender
 * markers is left alone — that is ordinary prose or a code sample.
 */
function isTransportEnvelope(tag: string, attrs: string): boolean {
  const name = tag.toLowerCase();
  if (name.includes("wecom") || name.includes("wechat") || name.includes("weixin")) return true;
  return name.includes("message") && ENVELOPE_MARKER_RE.test(attrs);
}

/**
 * Client / harness instruction blocks. Inner text is not a user utterance
 * (recap templates, cwd reminders, hook payloads). `time_reminder` is a
 * summary delimiter and is only stripped when the tag is closed; the unclosed
 * `now|用户话题` form stays for sanitizeSummaryContent.
 */
function isInstructionBlock(tag: string): boolean {
  const name = tag.toLowerCase();
  if (name === "recap") return true;
  if (name.endsWith("-reminder") || name.endsWith("_reminder")) return true;
  return /^(system|local|command|agent|task|hook)[-_]/.test(name);
}

function isUnclosedInstructionWrapper(tag: string): boolean {
  const name = tag.toLowerCase();
  if (name === "time_reminder" || name === "time-reminder") return false;
  return isInstructionBlock(name);
}

function unwrapTransportEnvelopes(text: string): string {
  const closed = /<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(closed)) {
    const index = match.index ?? 0;
    if (!isTransportEnvelope(match[1], match[2])) continue;
    out += text.slice(cursor, index);
    out += decodeBasicEntities(match[3]).trim();
    cursor = index + match[0].length;
  }
  out += text.slice(cursor);

  const open = /<([a-zA-Z][\w:-]*)\b([^>]*?)>/gi;
  for (let match = open.exec(out); match; match = open.exec(out)) {
    if (match[0].endsWith("/>")) continue;
    if (!isTransportEnvelope(match[1], match[2])) continue;
    const after = out.slice(match.index + match[0].length);
    if (hasCloseTag(after, match[1])) continue;
    out = (out.slice(0, match.index) + decodeBasicEntities(after)).trim();
    break;
  }
  return out;
}

function stripInstructionBlocks(text: string): string {
  let out = text.replace(/<([a-zA-Z][\w:-]*)\b[^>]*\/>/gi, (full, tag) =>
    isInstructionBlock(tag) ? "" : full
  );
  out = out.replace(/<([a-zA-Z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (full, tag) =>
    isInstructionBlock(tag) ? "" : full
  );

  const open = /<([a-zA-Z][\w:-]*)\b[^>]*>/gi;
  for (let match = open.exec(out); match; match = open.exec(out)) {
    if (match[0].endsWith("/>")) continue;
    if (!isUnclosedInstructionWrapper(match[1])) continue;
    const after = out.slice(match.index + match[0].length);
    if (hasCloseTag(after, match[1])) continue;
    out = out.slice(0, match.index);
    break;
  }
  return out;
}

/** Channel/harness status lines. Not speech — the send itself is in the tool call. */
function isDeliveryReceipt(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  return /^(已回(?:她|他|你|完)?|已回复|已发送|已送达)[。.!！]*$/u.test(compact);
}

/** Whole-utterance (or trailing) templates that clients inject without tags. */
function dropMachineProse(text: string): string {
  const stripped = text
    .replace(/(?:^|\n)user stepped away;?\s*returning\.\s*recap:[\s\S]*$/i, "")
    .replace(/(?:^|\n)recap:\s*<[\s\S]*$/i, "")
    .replace(/(?:^|\n)today:\s*\d{4}-\d{2}-\d{2}\b[\s\S]*current working directory[\s\S]*$/i, "")
    .trim();
  return stripped.split("\n").filter((line) => !isDeliveryReceipt(line.trim())).join("\n").trim();
}

/**
 * Keep the human sentence. Unwrap IM transport envelopes; drop client
 * recap / system-reminder / hook blocks and delivery receipts like 「已回她」.
 * Ordinary prose that happens to mention `<message>` or the word recap is
 * left untouched.
 */
export function cleanMessageText(input: string): string {
  let text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  text = unwrapTransportEnvelopes(text);
  text = stripInstructionBlocks(text);

  const newline = text.indexOf("\n");
  if (newline > 0) {
    const header = text.slice(0, newline);
    if (/\b(?:from|sender|sender_id)\s*[:=]/i.test(header) &&
        /\b(?:msg_id|message_id)\s*[:=]/i.test(header)) {
      text = text.slice(newline + 1).trim();
    }
  }

  text = dropMachineProse(text);
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
