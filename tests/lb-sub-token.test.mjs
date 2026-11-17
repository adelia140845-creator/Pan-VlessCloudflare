// Uji template Load Balancer (frontend/source/load-balancer.js) tanpa Cloudflare sungguhan:
// penjaga token langganan (SUB_TOKEN) dan cache pool 60 detik lewat Cache API.
// Jalankan: node --test tests/lb-sub-token.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { subTokenStatus } from "../frontend/source/load-balancer.js";

const ROWS = [{ ip: "203.0.113.7", port: "443", country: "SG", org: "Uji", ping: 12 }];

const subUrl = (query = "", host = "lb.test.workers.dev") => new URL(`https://${host}/api/v1/sub${query}`);
const env = (token) => ({ VPN_DOMAINS: "vpn.test.workers.dev", ...(token === undefined ? {} : { SUB_TOKEN: token }) });

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

// --- format=sing-box: JSON outbounds yang sama dengan panel --------------------

// Satu baris pool + dua port default (443, 80) = dua outbound; UUID sama karena satu permintaan.
const singboxHit = async (query, rows = ROWS) => {
  const calls = stubFetch(rows);
  stubCaches();
  const { ctx } = stubCtx();
  const response = await hit(`https://lb.test.workers.dev/api/v1/sub${query}`, env(), ctx);
  return { response, calls };
};

test("format=sing-box: JSON outbounds vless, tls hanya untuk port 443", async () => {
  const { response } = await singboxHit("?format=sing-box&limit=2");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");

  const body = await response.json();
  assert.equal(Array.isArray(body.outbounds), true);
  assert.equal(body.outbounds.length, 2);

  const [tls, plain] = body.outbounds;
  assert.equal(tls.type, "vless");
  assert.equal(tls.server, "vpn.test.workers.dev");
  assert.equal(tls.server_port, 443);
  assert.match(tls.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(tls.tls, { enabled: true, server_name: "vpn.test.workers.dev", insecure: false });
  assert.deepEqual(tls.transport, {
    type: "ws",
    path: "/203.0.113.7-443",
    headers: { Host: "vpn.test.workers.dev" },
  });
  assert.equal(tls.tag.startsWith("1 "), true);
  assert.equal(tls.tag.endsWith("Uji TLS"), true, "label tidak lagi memuat penanda Free/Premium");

  assert.equal(plain.type, "vless");
  assert.equal(plain.server_port, 80);
  assert.equal(plain.uuid, tls.uuid);
  assert.equal("tls" in plain, false, "port non-TLS tidak boleh membawa blok tls");
  assert.equal(plain.tag.endsWith("Uji NTLS"), true);
  assert.deepEqual(plain.transport, tls.transport);
});

test("format=singbox (alias) mengeluarkan JSON yang sama seperti sing-box", async () => {
  const { response } = await singboxHit("?format=singbox&limit=2");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");

  const body = await response.json();
  assert.equal(body.outbounds.length, 2);
  assert.equal(body.outbounds[0].type, "vless");
  assert.equal(body.outbounds[0].server_port, 443);
  assert.equal(body.outbounds[0].tls.enabled, true);
  assert.equal(body.outbounds[0].transport.type, "ws");
  assert.equal(body.outbounds[1].server_port, 80);
  assert.equal("tls" in body.outbounds[1], false);
});

test("format lain tidak berubah: clash YAML, v2ray base64, format tak dikenal raw", async () => {
  const clash = await singboxHit("?format=clash&limit=2");
  assert.equal(clash.response.headers.get("Content-Type"), "application/x-yaml; charset=utf-8");
  const yaml = await clash.response.text();
  assert.equal(yaml.startsWith("proxies:\n  - name: \"1 "), true);
  assert.match(yaml, /^ {4}type: vless$/m);
  assert.match(yaml, /^ {4}tls: true$/m);
  assert.match(yaml, /^ {4}network: ws$/m);

  // Label VLESS masuk hash sebagai encodeURIComponent, jadi badan base64 tetap ASCII (btoa aman)
  // walau labelnya memuat emoji bendera.
  const v2ray = await singboxHit("?format=v2ray&limit=2");
  assert.equal(v2ray.response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  const decoded = Buffer.from(await v2ray.response.text(), "base64").toString("utf8");
  assert.equal(decoded.split("\n").length, 2);
  assert.match(decoded, /^vless:\/\//);

  const unknown = await singboxHit("?format=bogus&limit=2");
  assert.equal(unknown.response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  const raw = await unknown.response.text();
  assert.equal(raw.split("\n").length, 2);
  assert.match(raw, /^vless:\/\//);
  assert.equal(raw.trim().startsWith("{"), false, "format tak dikenal tetap teks raw, bukan JSON");
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

// --- ?uuid=: UUID tetap untuk worker yang dikunci UUID_ALLOWLIST ----------------

test("uuid= valid dipakai apa adanya untuk semua config (worker ber-UUID_ALLOWLIST)", async () => {
  const fixed = "11111111-2222-4333-8444-555555555555";
  const { response } = await singboxHit(`?format=raw&limit=2&uuid=${fixed}`);
  const lines = (await response.text()).split("\n").filter(Boolean);

  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.match(line, new RegExp(`^vless://${fixed}@`), "setiap config memakai UUID yang dikirim");
  }
});

test("uuid= tidak sah atau kosong: UUID acak seperti sebelumnya, tidak crash", async () => {
  const uuidRe = /^vless:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/;

  const bad = await singboxHit("?format=raw&limit=2&uuid=bukan-uuid");
  const first = (await bad.response.text()).split("\n").filter(Boolean)[0];
  assert.match(first, uuidRe, "UUID tidak sah diganti UUID acak yang sah");
  assert.doesNotMatch(first, /bukan-uuid/);

  const empty = await singboxHit("?format=raw&limit=2&uuid=");
  const second = (await empty.response.text()).split("\n").filter(Boolean)[0];
  assert.match(second, uuidRe);
});

test("tanpa ?domains= dan tanpa VPN_DOMAINS: 400 dengan pesan jelas (tidak merakit host asing)", async () => {
  stubFetch(ROWS);
  stubCaches();
  const { ctx } = stubCtx();
  const noDomains = { ...env() };
  delete noDomains.VPN_DOMAINS;
  const response = await hit("https://lb.test.workers.dev/api/v1/sub?format=raw&limit=2", noDomains, ctx);
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.match(body, /domains/i);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("insecure=1: allowInsecure hanya untuk port TLS, ikut di clash dan sing-box", async () => {
  const raw = await singboxHit("?format=raw&limit=2&insecure=1");
  const lines = (await raw.response.text()).split("\n").filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const u = new URL(line);
    const tls = u.searchParams.get("security") === "tls";
    assert.equal(u.searchParams.get("allowInsecure"), tls ? "1" : null, "hanya config TLS yang membawa allowInsecure");
  }

  const clash = await singboxHit("?format=clash&limit=2&insecure=1");
  assert.match(await clash.response.text(), /skip-cert-verify: true/);

  const sing = await singboxHit("?format=sing-box&limit=2&insecure=1");
  const body = JSON.parse(await sing.response.text());
  const tlsOut = body.outbounds.find((o) => o.server_port === 443);
  assert.equal(tlsOut.tls.insecure, true);

  const plain = await singboxHit("?format=raw&limit=2");
  for (const line of (await plain.response.text()).split("\n").filter(Boolean)) {
    assert.equal(new URL(line).searchParams.get("allowInsecure"), null, "tanpa parameter: perilaku lama");
  }
});

test.after(() => {
  delete globalThis.caches;
  globalThis.fetch = realFetch;
});