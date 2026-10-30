// language: TypeScript, file: src/index.ts, runtime: Cloudflare Workers
interface Env {
  KV: KVNamespace;
  AUTH_TOKEN: string;
}

interface ServerStatus {
  id: string;
  name: string;
  host: string;
  port: number;
  online: boolean;
  players: number;
  maxPlayers: number;
  mode: string;
  map: string;
  updated_at: number;
  from_ip?: string;
}

const ONLINE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_MS = 10 * 1000;
const lastPostByIp = new Map<string, number>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function validateServer(body: unknown): ServerStatus | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const b = body as Record<string, unknown>;
  const id = String(b.id ?? "").trim();
  if (!id || id.length > 64) return "id is required, max 64 chars";
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 100) return "name is required, max 100 chars";
  const host = String(b.host ?? "").trim();
  if (!host || host.length > 255) return "host is required, max 255 chars";
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be integer 1-65535";
  const online = Boolean(b.online);
  const players = Number(b.players ?? 0);
  const maxPlayers = Number(b.maxPlayers ?? 0);
  if (!Number.isInteger(players) || players < 0 || players > 1000) return "players must be integer 0-1000";
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000) return "maxPlayers must be integer 1-1000";
  if (players > maxPlayers) return "players cannot exceed maxPlayers";
  return {
    id, name, host, port, online, players, maxPlayers,
    mode: String(b.mode ?? "Classic").slice(0, 50),
    map: String(b.map ?? "Unknown").slice(0, 100),
    updated_at: Date.now(),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (path === "/api/health" && req.method === "GET") {
      return json({ ok: true, ts: Date.now(), service: "world-hub-backend" });
    }

    if (path === "/api/servers" && req.method === "GET") {
      const list: ServerStatus[] = [];
      const cutoff = Date.now() - ONLINE_TTL_MS;
      const keys = await env.KV.list({ prefix: "server:" });
      for (const key of keys.keys) {
        const raw = await env.KV.get(key.name, "json") as ServerStatus | null;
        if (raw) {
          if (raw.updated_at < cutoff) raw.online = false;
          list.push(raw);
        }
      }
      list.sort((a, b) =>
        (Number(b.online) - Number(a.online)) ||
        ((b.online ? b.players : 0) - (a.online ? a.players : 0)) ||
        a.name.localeCompare(b.name, "ru")
      );
      return json(list);
    }

    if (path === "/api/status" && req.method === "POST") {
      const auth = req.headers.get("Authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return error("missing Bearer token", 401);
      if (auth.slice(7) !== env.AUTH_TOKEN) return error("invalid token", 403);

      const now = Date.now();
      const last = lastPostByIp.get(ip) ?? 0;
      if (now - last < RATE_LIMIT_MS) return error("too many requests", 429);
      lastPostByIp.set(ip, now);

      const body = await req.text();
      if (body.length > MAX_BODY_BYTES) return error("body too large", 413);

      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return error("invalid JSON", 400); }

      const result = validateServer(parsed);
      if (typeof result === "string") return error(result, 400);
      result.from_ip = ip;

      await env.KV.put(`server:${result.id}`, JSON.stringify(result));
      return json({ ok: true, id: result.id, updated_at: result.updated_at });
    }

    return error("not found", 404);
  },
};
