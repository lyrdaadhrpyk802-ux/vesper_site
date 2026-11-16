// Vesper: Worker entry + Durable Object for pins, stats and visits.
// Static files (index.html, audio.mp3) are served from /public by Workers Assets.

const ALLOWED_ORIGINS = ["https://v.vespernoir.workers.dev"]; // add your custom domain here

const MAX_PINS = 1000;
const PIN_TTL_MS = 60 * 86400000;
const DAY_MS = 86400000;
const MAX_BODY = 2048;
const CACHE_TTL_SEC = 20;

const BLOCKED = ["fuck", "shit", "bitch", "asshole", "bastard", "nigger", "faggot", "cunt", "whore"];

const ROUTES = {
  "GET /api/pins":         { path: "/pins",        edgeCache: CACHE_TTL_SEC },
  "POST /api/pins":        { path: "/pins",        rateLimit: true },
  "POST /api/pins/delete": { path: "/pins/delete" },
  "GET /api/stats":        { path: "/stats",       edgeCache: CACHE_TTL_SEC },
  "POST /api/visit":       { path: "/visit" },
};

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const enc = new TextEncoder();

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Removal code: 6 characters without easily confused letters.
function makeCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => alphabet[b % alphabet.length]).join("");
}

const clean = (s, max) =>
  [...String(s ?? "").replace(/[\u0000-\u001F\u007F<>]/g, "").trim()].slice(0, max).join("");

const isBlocked = (text) => {
  const n = text.toLowerCase().replace(/[^a-z\u0600-\u06FF]/g, "");
  return BLOCKED.some((w) => n.includes(w));
};

const dayKey = () => new Date().toISOString().slice(0, 10);

// Coordinates are stored to 4 decimals (about 11 m), enough for a precise pin
// without publishing an exact home address.
const round4 = (n) => Math.round(n * 10000) / 10000;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY,
      ...extra,
    },
  });
}

// One pin creation per minute per IP, stored in the edge cache (expires by itself)
async function isRateLimited(ipHash) {
  const cache = caches.default;
  const key = new Request(`https://ratelimit.internal/${ipHash}`);
  if (await cache.match(key)) return true;
  await cache.put(key, new Response("1", { headers: { "Cache-Control": "max-age=60" } }));
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, ...SECURITY, "Access-Control-Max-Age": "600" } });
    }

    const route = ROUTES[`${request.method} ${url.pathname}`];
    if (!route) return jsonResponse({ detail: "Not found." }, 404, cors);

    if (route.rateLimit) {
      const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
      const ipHash = await sha256(ip + (env.IP_SALT || "vesper-salt"));
      if (await isRateLimited(ipHash)) {
        return jsonResponse({ detail: "Please wait a minute before placing another pin." }, 429, cors);
      }
    }

    let body;
    if (request.method === "POST") {
      body = await request.text();
      if (body.length > MAX_BODY) return jsonResponse({ detail: "Request is too large." }, 413, cors);
    }

    const cacheKey = new Request(`${url.origin}${url.pathname}`);
    if (route.edgeCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    const stub = env.STATE.get(env.STATE.idFromName("global"));
    const upstream = await stub.fetch(`https://state.internal${route.path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await upstream.text();

    const res = new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": route.edgeCache ? `public, max-age=${route.edgeCache}` : "no-store",
        ...SECURITY,
        ...cors,
      },
    });
    if (route.edgeCache && upstream.ok) ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
  },
};

export class VesperState {
  constructor(state, env) {
    this.s = state.storage;
    this.env = env;
    this.cache = null;          // { at, list } in-memory copy of live pins
    this.pendingDay = null;     // visits buffered in memory, flushed every 30 s
    this.pendingVisits = 0;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const isGet = request.method === "GET";
    let data = {};
    if (!isGet) {
      const raw = await request.text();
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { return jsonResponse({ detail: "Invalid request." }, 400); }
      }
    }

    if (pathname === "/pins" && isGet) return jsonResponse(await this.publicPins());
    if (pathname === "/pins" && !isGet) return this.createPin(data);
    if (pathname === "/pins/delete" && !isGet) return this.deletePin(data);
    if (pathname === "/stats" && isGet) return this.stats();
    if (pathname === "/visit" && !isGet) return this.visit();
    return jsonResponse({ detail: "Not found." }, 404);
  }

  // Live pins, oldest first. Expired pins are removed here.
  async alive() {
    if (this.cache && Date.now() - this.cache.at < 15000) return this.cache.list;

    const now = Date.now();
    const map = await this.s.list({ prefix: "pin:", limit: MAX_PINS + 200 });
    const live = [], dead = [];
    for (const [key, v] of map) {
      (now - v.t > PIN_TTL_MS ? dead : live).push({ id: key, ...v });
    }
    if (dead.length) await this.dropKeys(dead.map((p) => p.id));
    live.sort((a, b) => a.t - b.t);

    this.cache = { at: now, list: live };
    return live;
  }

  async dropKeys(keys) {
    for (let i = 0; i < keys.length; i += 128) await this.s.delete(keys.slice(i, i + 128));
    this.cache = null;
  }

  async publicPins() {
    return (await this.alive()).map(({ id, name, msg, lat, lng, t }) => ({ id, name, msg, lat, lng, t }));
  }

  async createPin(data) {
    const name = clean(data.name, 10);
    const msg = clean(data.msg, 40);
    const lat = Number(data.lat);
    const lng = Number(data.lng);

    if (!name) return jsonResponse({ detail: "Name must be 1 to 10 characters." }, 400);
    if (isBlocked(name) || isBlocked(msg)) return jsonResponse({ detail: "That word is not allowed here." }, 400);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return jsonResponse({ detail: "Invalid latitude." }, 400);
    if (!Number.isFinite(lng) || Math.abs(lng) > 180) return jsonResponse({ detail: "Invalid longitude." }, 400);

    const live = await this.alive();
    if (live.length >= MAX_PINS) {
      // Make room by removing the oldest pins
      await this.dropKeys(live.slice(0, live.length - MAX_PINS + 1).map((p) => p.id));
    }

    const code = makeCode();
    const id = `pin:${Date.now().toString(36)}:${randomHex(4)}`;
    const rec = {
      name,
      msg,
      lat: round4(lat),
      lng: round4(lng),
      t: Date.now(),
      h: await sha256(code), // only the hash of the removal code is stored
    };
    await this.s.put(id, rec);
    this.cache = null;
    return jsonResponse({ ok: true, id, code }, 201);
  }

  async deletePin(data) {
    const id = String(data.id ?? "");
    const code = String(data.code ?? "").toUpperCase().trim();
    if (!id.startsWith("pin:")) return jsonResponse({ detail: "Pin not found." }, 404);

    const rec = await this.s.get(id);
    if (!rec) return jsonResponse({ detail: "Pin not found." }, 404);
    if ((await sha256(code)) !== rec.h) return jsonResponse({ detail: "The removal code does not match." }, 403);

    await this.s.delete(id);
    this.cache = null;
    return jsonResponse({ ok: true });
  }

  async stats() {
    const now = Date.now();
    const live = await this.alive();
    const day = dayKey();
    const stored = Number((await this.s.get(`visits:${day}`)) || 0);
    const pending = this.pendingDay === day ? this.pendingVisits : 0;
    return jsonResponse({
      pinsTotal: live.length,
      pins24h: live.filter((p) => now - p.t < DAY_MS).length,
      visitsToday: stored + pending,
    });
  }

  async visit() {
    const day = dayKey();
    if (this.pendingDay !== day) {
      await this.flushVisits();
      this.pendingDay = day;
      this.pendingVisits = 0;
    }
    this.pendingVisits++;
    if ((await this.s.getAlarm()) === null) await this.s.setAlarm(Date.now() + 30000);
    return jsonResponse({ ok: true });
  }

  async flushVisits() {
    if (!this.pendingDay || !this.pendingVisits) return;
    const key = `visits:${this.pendingDay}`;
    const current = Number((await this.s.get(key)) || 0);
    await this.s.put(key, current + this.pendingVisits);
    this.pendingVisits = 0;
  }

  async alarm() {
    await this.flushVisits();
  }
}