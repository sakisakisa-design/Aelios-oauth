import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SECRET_SPECS, SETTINGS } from '../src/gateway/settings';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * Every env var the code actually consumes has to be one of:
 *   - a SETTINGS entry, so it can be changed from /admin without a redeploy;
 *   - a SECRET, which lives in Worker secrets and is only reported as present;
 *   - INTERNAL, with a written reason for staying out of the page.
 *
 * The two drifts this guards against are the ones that made the page unreliable:
 * knobs that only exist as Worker vars (invisible unless you read the source), and
 * Env keys left behind by a removed feature (visible in types.ts, read by nothing).
 */

/** Reads that are not runtime knobs, each with the reason it stays off the page. */
const INTERNAL: Record<string, string> = {
  DB: 'D1 binding',
  AI: 'Workers AI binding',
  MEMORY_QUEUE: 'queue binding',
  VECTORIZE: 'Vectorize binding',
  GATEWAY_CONFIG: '内部 JSON blob（/admin 的配置本体），不是开关',
  AI_GATEWAY_BASE_URL: '/admin 的上游地址优先，这个只是 Worker var 兜底',
  CLOUDFLARE_ACCOUNT_ID: '同上：上游地址里的账户 ID 优先',
  CF_AIG_TOKEN: 'Worker secret，出自 SECRETS.md',
  DAILY_DIGEST_MODEL: 'readDreamModel 的旧名兜底，前面有 DREAM_MODEL',
  DAILY_DIGEST_TIME_ZONE: 'readDreamTimeZone 的旧名兜底',
  DAILY_DIGEST_MAX_MESSAGES: 'readDreamMaxMessages 的旧名兜底',
  DAILY_DIGEST_MAX_TOKENS: 'readDreamMaxTokens 的旧名兜底',
  DAILY_DIGEST_MEMORY_CONTEXT_LIMIT: 'readDreamMemoryContextLimit 的旧名兜底',
  DAILY_DIGEST_MAX_RUNS: 'DREAM_MAX_RUNS 的旧名兜底',
  ENABLE_DAILY_MEMORY_DIGEST: 'isDreamEnabled 的旧名兜底，ENABLE_DREAM 优先'
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Env reads in src/, in both shapes the repo uses: `env.NAME` and the model-name
 * lists passed to `readModelName(env, ["NAME", ...])`. A helper that reads env by a
 * string key it builds at runtime would slip past this — none exists today.
 */
function envReads(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const record = (name: string, where: string) => {
    const places = found.get(name) ?? [];
    if (!places.includes(where)) places.push(where);
    found.set(name, places);
  };
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('types.ts')) continue;
    const relative = file.slice(SRC.length + 1);
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) record(match[1], relative);
    for (const call of content.matchAll(/readModelName\([^;]*?\[([^\]]*)\]/g)) {
      for (const name of call[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) record(name[1], relative);
    }
  }
  return found;
}

test('every env var the code reads is either on the settings page, a secret, or documented as internal', () => {
  const allowed = new Set([
    ...SETTINGS.map((spec) => spec.name),
    ...SECRET_SPECS.map((spec) => spec.name),
    ...Object.keys(INTERNAL)
  ]);
  const unaccounted = [...envReads()]
    .filter(([name]) => !allowed.has(name))
    .map(([name, places]) => `${name} (${places.join(', ')})`);
  assert.deepEqual(unaccounted, [],
    'add the knob to SETTINGS, or add it to INTERNAL with the reason it stays off the page');
});

test('every internal env var carries a reason', () => {
  const undocumented = Object.entries(INTERNAL).filter(([, reason]) => !reason.trim()).map(([name]) => name);
  assert.deepEqual(undocumented, [], 'INTERNAL entries need a reason');
});

test('every settings entry is actually read by the code', () => {
  const reads = envReads();
  const dead = SETTINGS.map((spec) => spec.name).filter((name) => !reads.has(name));
  assert.deepEqual(dead, [],
    'a setting nothing reads would silently do nothing after being saved');
});
