import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { identityNamespace, invalidateSettingsCache, loadConfig, validateConfig } from "./config";
import { describeSettings } from "./settings";

async function ownerOnly(request: Request, env: Env): Promise<boolean> {
  const auth = await authenticate(request, env);
  return auth.ok && ["CHATBOX_API_KEY", "DEBUG_API_KEY"].includes(auth.keyName);
}
/** Reports the values this Worker was deployed with, so the page can show them as placeholders. */
export async function handleGatewayEnv(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  let settings = {};
  try { settings = (await loadConfig(env)).settings || {}; } catch { settings = {}; }
  return Response.json(describeSettings(env, settings), { headers: { "cache-control": "no-store" } });
}
export async function handleGatewayAdmin(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  try {
    if (request.method === "GET") return Response.json(await loadConfig(env), { headers: { "cache-control": "no-store" } });
    if (request.method !== "PUT") return Response.json({ error: "Use GET or PUT" }, { status: 405, headers: { allow: "GET, PUT" } });
    let config;
    try { config = validateConfig(await request.json()); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid config" }, { status: 400 }); }
    await env.DB.prepare(`INSERT INTO gateway_config (id, config_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(config), new Date().toISOString()).run();
    invalidateSettingsCache();
    return Response.json({ ok: true, identities: config.identities.length, settings: Object.keys(config.settings || {}).length });
  } catch { return Response.json({ error: "Configuration store unavailable. Apply D1 migrations first." }, { status: 503 }); }
}
/** Read-only recall explanations for one configured identity, including empty/error decisions. */
export async function handleRecallHistory(request: Request, env: Env): Promise<Response> {
  if (!await ownerOnly(request, env)) return Response.json({ error: "Owner key required" }, { status: 401 });
  const slug = new URL(request.url).searchParams.get("identity");
  const config = await loadConfig(env);
  const identity = config.identities.find(i => i.slug === slug);
  if (!identity) return Response.json({ error: "Unknown identity" }, { status: 400 });
  const rows = await env.DB.prepare(`SELECT id, created_at, payload_json FROM memory_events
    WHERE namespace = ? AND event_type = 'recall_explain' AND json_extract(payload_json, '$.identity') = ?
    ORDER BY created_at DESC, id DESC LIMIT 20`).bind(identityNamespace(identity), identity.slug)
    .all<{ id: string; created_at: string; payload_json: string }>();
  return Response.json({ items: (rows.results || []).map(row => ({
    id: row.id, created_at: row.created_at, ...JSON.parse(row.payload_json)
  })) }, { headers: { "cache-control": "no-store" } });
}
