// Uji template Load Balancer (frontend/source/load-balancer.js) tanpa Cloudflare sungguhan:
// penjaga token langganan (SUB_TOKEN) dan cache pool 60 detik lewat Cache API.
// Jalankan: node --test tests/lb-sub-token.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { subTokenStatus } from "../frontend/source/load-balancer.js";

const ROWS = [{ ip: "203.0.113.7", port: "443", country: "SG", org: "Uji", ping: 12 }];

const subUrl = (query = "", host = "lb.test.workers.dev") => new URL(`https://${host}/api/v1/sub${query}`);
const env = (token) => ({ VPN_DOMAINS_FREE: "vpn.test.workers.dev", ...(token === undefined ? {} : { SUB_TOKEN: token }) });

// Stub Supabase: hitung berapa kali tabel ditarik, dan balas baris ROWS.
function stubFetch(rows = ROWS) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

// Stub caches.default: Map-backed, dan mencatat isi put.
function stubCaches({ putRejects = false } = {}) {
  const store = new Map();
  const puts = [];
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = store.get(String(key.url ?? key));
        return hit ? hit.clone() : undefined;
      },
      async put(key, response) {
        if (putRejects) throw new Error("kuota cache habis");
        puts.push({ url: String(key.url ?? key), response });
        store.set(String(key.url ?? key), response.clone());
      },
    },
  };
  return puts;
}

const noCaches = () => { delete globalThis.caches; };

// ctx palsu: waitUntil ditampung supaya penulisan cache ikut selesai sebelum assert.
function stubCtx() {
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  ctx.pending = pending;
  return { pending, ctx };
}

const hit = async (url, environment, ctx) => {
  const response = await worker.fetch(new Request(url), environment, ctx);
  await Promise.all(ctx.pending ?? []);
  return response;
};

const realFetch = globalThis.fetch;

// --- subTokenStatus (fungsi murni pengecek query) ---------------------------

test("tanpa SUB_TOKEN langganan tetap terbuka: status 200 walau tanpa t", () => {
  assert.equal(subTokenStatus(subUrl("?format=raw"), undefined), 200);
  assert.equal(subTokenStatus(subUrl("?format=raw"), ""), 200);
  assert.equal(subTokenStatus(subUrl("?format=raw"), "   "), 200);
  assert.equal(subTokenStatus(subUrl("?format=raw"), null), 200);
});

test("SUB_TOKEN diisi: t kosong atau salah dihitung 403", () => {
  assert.equal(subTokenStatus(subUrl("?format=raw"), "rahasia123"), 403);
  assert.equal(subTokenStatus(subUrl("?format=raw&t="), "rahasia123"), 403);
  assert.equal(subTokenStatus(subUrl("?format=raw&t=salah"), "rahasia123"), 403);
  assert.equal(subTokenStatus(subUrl("?format=raw&t=rahasia1234"), "rahasia123"), 403);
});

test("SUB_TOKEN diisi: t benar = 200, token= juga diterima", () => {
  assert.equal(subTokenStatus(subUrl("?t=rahasia123"), "rahasia123"), 200);
  assert.equal(subTokenStatus(subUrl("?token=rahasia123"), "rahasia123"), 200);
  assert.equal(subTokenStatus(subUrl("?format=raw&limit=5&t=rahasia123"), " rahasia123 "), 200);
});

// --- handler: token dulu, baru cache/Supabase ---------------------------------

test("tanpa t handler membalas 403 dan tidak menyentuh Supabase maupun cache", async () => {
  const calls = stubFetch();
  const puts = stubCaches();
  const { ctx } = stubCtx();

  const forbidden = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&t=salah", env("rahasia123"), ctx);
  assert.equal(forbidden.status, 403);
  assert.match(await forbidden.text(), /Token langganan tidak valid/);
  assert.equal(forbidden.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(calls.length, 0, "fetch Supabase tidak boleh jalan saat token salah");
  assert.equal(puts.length, 0, "cache tidak boleh diisi saat token salah");

  const missing = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw", env("rahasia123"), ctx);
  assert.equal(missing.status, 403);
  assert.equal(calls.length, 0);
});

test("t benar: handler melayani langganan dan mengisi cache dari URL Supabase", async () => {
  const calls = stubFetch();
  const puts = stubCaches();
  const { ctx } = stubCtx();

  const ok = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1&t=rahasia123", env("rahasia123"), ctx);
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.equal(body.split("\n").length, 1);
  assert.match(body, /^vless:\/\//);

  assert.equal(calls.length, 1);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url.startsWith("https://lumbbmhhmkcnxunuryjr.supabase.co/rest/v1/proxy_pool"), true);
  assert.equal(puts[0].response.headers.get("Cache-Control"), "public, max-age=60");
  assert.equal(puts[0].response.headers.get("Content-Type"), "application/json");
});

test("cache 60 detik: permintaan kedua dilayani cache, Supabase tidak ditarik lagi", async () => {
  const calls = stubFetch();
  stubCaches();
  const { ctx } = stubCtx();
  const url = "https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1";

  const first = await hit(url, env(), ctx);
  const second = await hit(url, env(), ctx);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 1, "tarikan kedua harus dilayani cache 60 detik");
  assert.equal((await second.text()).startsWith("vless://"), true);
});

test("cache tidak tersedia (mis. wrangler dev): tetap melayani, jatuh ke fetch langsung", async () => {
  const calls = stubFetch();
  const { ctx } = stubCtx();
  noCaches();
  const url = "https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1";

  const first = await hit(url, env(), ctx);
  const second = await hit(url, env(), ctx);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 2, "tanpa Cache API tiap permintaan menarik Supabase sendiri");
});

test("cache.put ditolak tetap tidak menggagalkan langganan", async () => {
  stubFetch();
  stubCaches({ putRejects: true });
  const { ctx } = stubCtx();

  const response = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1", env(), ctx);
  assert.equal(response.status, 200);
});

test("Supabase gagal: langganan balas 200 dengan badan kosong, bukan error", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  const puts = stubCaches();
  const { ctx } = stubCtx();

  const response = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1", env(), ctx);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  // Hasil kosong tidak di-cache: gangguan sesaat di Supabase tidak terkunci 60 detik.
  assert.equal(puts.length, 0);

  const again = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&limit=1", env(), ctx);
  assert.equal(again.status, 200);
  assert.equal(puts.length, 0);
});

// --- /health: selalu terbuka, tidak ikut gerbang SUB_TOKEN ------------------

test("GET /health terbuka tanpa token langganan: 200 + JSON jenis/versi + CORS, tanpa menyentuh Supabase", async () => {
  const calls = stubFetch();
  noCaches();
  const { ctx } = stubCtx();

  const response = await hit("https://lb.test.workers.dev/health", env("rahasia123"), ctx);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(body.ok, true);
  assert.equal(body.type, "load_balancer");
  assert.match(body.version, /^\d{4}-\d{2}-\d{2}[a-z]$/, "versi wajib ada supaya panel bisa membandingkannya");
  assert.equal(calls.length, 0, "/health tidak perlu menarik pool dari Supabase");

  // Token langganan yang salah TIDAK menutup /health: gerbang itu hanya milik /api/v1/sub.
  const withBadToken = await hit("https://lb.test.workers.dev/health?t=salah", env("rahasia123"), ctx);
  assert.equal(withBadToken.status, 200);
  assert.equal((await withBadToken.json()).type, "load_balancer");

  // Tanpa binding SUB_TOKEN pun sama saja (worker terbuka).
  const openEnv = await hit("https://lb.test.workers.dev/health", env(), ctx);
  assert.equal(openEnv.status, 200);
  assert.equal(calls.length, 0);
});

test("OPTIONS /health menjawab preflight dengan CORS (panel memanggil lintas origin)", async () => {
  stubFetch();
  noCaches();
  const { ctx } = stubCtx();

  const response = await worker.fetch(
    new Request("https://lb.test.workers.dev/health", { method: "OPTIONS" }),
    env("rahasia123"),
    ctx
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test.after(() => {
  delete globalThis.caches;
  globalThis.fetch = realFetch;
});
