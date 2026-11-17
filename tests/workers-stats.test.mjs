// Uji statistik pemakaian worker + ringkasan uptime /health.
//
//  (a) helper murni ringkasan uptime dari cache (frontend/redeploy.js),
//  (b) pembuat permintaan statistik Cloudflare: URL GraphQL, body, jendela jam, dan escape nama
//      script (functions/api/workers-stats.js),
//  (c) penanganan error saat balasan Cloudflare bukan sukses,
//  (d) route POST /api/workers-stats dengan fetch yang DISTUB: tidak ada permintaan sungguhan ke
//      Cloudflare maupun Supabase, dan permintaan yang tercatat diperiksa apa adanya.
//
// Jalankan: node --test tests/workers-stats.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WORKER_HEALTH_CACHE_KEY,
  HEALTH_HISTORY_LIMIT,
  healthSampleFromProbe,
  appendHealthSample,
  summarizeHealthHistory,
  workerVersionState,
  versionStateFromHealth,
  formatCheckedAt,
  pruneHealthCache,
  createSubToken,
  redeployVars,
  withSubToken,
} from "../frontend/redeploy.js";
import {
  STATS_ENDPOINT,
  STATS_DEFAULT_HOURS,
  STATS_MAX_HOURS,
  STATS_MAX_SCRIPTS,
  DEFAULT_DAILY_QUOTA,
  ANALYTICS_SCOPE_HINT,
  statsWindowHours,
  todayWindow,
  summarizeQuota,
  normalizeScriptNames,
  buildInvocationsQuery,
  buildBatchInvocationsQuery,
  readInvocationsTotals,
  readAliasedTotals,
  cloudflareStatsError,
  onRequest,
} from "../functions/api/workers-stats.js";

const T0 = 1_700_000_000_000; // titik waktu tetap supaya jendela jam bisa dihitung pasti

// --- (a) Ringkasan uptime dari cache ----------------------------------------

test("kunci cache uptime dan batas riwayat per worker", () => {
  assert.equal(WORKER_HEALTH_CACHE_KEY, "workerHealthCache");
  assert.equal(HEALTH_HISTORY_LIMIT, 20);
});

test("healthSampleFromProbe: 4xx berarti worker MENJAWAB (hidup), 5xx dan jaringan mati tidak", () => {
  const ok = healthSampleFromProbe({ at: T0, latencyMs: 41.6, status: 200, reachable: true, version: "2026-11-15a" });
  assert.deepEqual(ok, { at: T0, up: true, status: 200, latencyMs: 42, version: "2026-11-15a", type: null, error: null });

  // /health dikunci HEALTH_TOKEN: worker tetap ada dan menjawab, jadi bukan "mati".
  const gated = healthSampleFromProbe({ at: T0, latencyMs: 12, status: 401, reachable: true });
  assert.equal(gated.up, true);
  assert.equal(gated.status, 401);
  assert.equal(gated.version, null);

  const broken = healthSampleFromProbe({ at: T0, latencyMs: 12, status: 500, reachable: true });
  assert.equal(broken.up, false);

  const unreachable = healthSampleFromProbe({ at: T0, latencyMs: -5, status: 0, reachable: false, error: "Failed to fetch" });
  assert.equal(unreachable.up, false);
  assert.equal(unreachable.latencyMs, null, "latensi negatif tidak boleh lolos apa adanya");
  assert.equal(unreachable.error, "Failed to fetch");

  // Masukan rusak tidak melempar: sampel tetap terbentuk dengan nilai aman.
  const junk = healthSampleFromProbe(null);
  assert.equal(junk.up, false);
  assert.equal(junk.status, 0);
  assert.equal(junk.latencyMs, null);
  assert.ok(Number.isFinite(junk.at));
});

test("appendHealthSample menyimpan 20 sampel TERAKHIR, bukan menumpuk tanpa batas", () => {
  let history = [];
  for (let i = 1; i <= 25; i += 1) {
    history = appendHealthSample(history, healthSampleFromProbe({ at: T0 + i * 1000, status: 200, reachable: true, latencyMs: 10 }));
  }
  assert.equal(history.length, HEALTH_HISTORY_LIMIT);
  assert.equal(history[0].at, T0 + 6000, "sampel paling lama dibuang");
  assert.equal(history[history.length - 1].at, T0 + 25_000, "sampel terbaru ada di akhir");

  // Riwayat rusak (bukan larik / berisi bukan objek) tetap bisa dipakai.
  assert.equal(appendHealthSample("bukan larik", { at: T0 }).length, 1);
  assert.deepEqual(appendHealthSample([null, 5, { at: 1 }], { at: 2 }), [{ at: 1 }, { at: 2 }]);
  assert.equal(appendHealthSample([], { at: T0 }, 1).length, 1);
});

test("summarizeHealthHistory menghitung uptime, latensi rata-rata, dan sampel terakhir", () => {
  const sample = (at, up, latencyMs, version) => ({ at, up, status: up ? 200 : 500, latencyMs, version });

  const summary = summarizeHealthHistory([
    sample(T0, true, 100, "2026-11-15a"),
    sample(T0 + 1000, false, 0, null),
    sample(T0 + 2000, true, 200, "2026-11-15a"),
    sample(T0 + 3000, true, 300, "2026-11-15a"),
  ]);

  assert.equal(summary.checks, 4);
  assert.equal(summary.up, 3);
  assert.equal(summary.down, 1);
  assert.equal(summary.uptimePct, 75);
  assert.equal(summary.avgLatencyMs, 200, "hanya sampel hidup yang berlatensi > 0 ikut dihitung");
  assert.equal(summary.lastAt, T0 + 3000);
  assert.equal(summary.lastUp, true);
  assert.equal(summary.lastStatus, 200);
  assert.equal(summary.lastVersion, "2026-11-15a");
});

test("riwayat kosong berarti uptime belum diketahui (null), bukan 0%", () => {
  const empty = summarizeHealthHistory(undefined);
  assert.equal(empty.checks, 0);
  assert.equal(empty.uptimePct, null);
  assert.equal(empty.avgLatencyMs, null);
  assert.equal(empty.last, null);
  assert.equal(empty.lastAt, null);
  assert.equal(empty.lastUp, null);
  assert.equal(empty.lastError, null);
});

test("workerVersionState: terbaru, lama, dan tidak diketahui", () => {
  assert.equal(workerVersionState("2026-11-15a", "2026-11-15a"), "current");
  assert.equal(workerVersionState(" 2026-11-15a ", "2026-11-15a"), "current");
  assert.equal(workerVersionState("2026-11-10x", "2026-11-15a"), "stale");
  // Sisi mana pun kosong berarti belum bisa divonis (worker belum menjawab /health).
  assert.equal(workerVersionState(null, "2026-11-15a"), "unknown");
  assert.equal(workerVersionState("", "2026-11-15a"), "unknown");
  assert.equal(workerVersionState("2026-11-15a", ""), "unknown");
});

// Versi template frontend yang benar-benar dipakai app.js. Dipakai oleh versionStateFromHealth.
const TEMPLATES = { vpn: "2026-11-15a", load_balancer: "2026-11-15a" };

test("versionStateFromHealth: worker VPN dibandingkan dengan versi VPN, bukan versi LB", () => {
  // Template VPN sekarang belum mengirim `type` -> dianggap template jenis worker itu sendiri.
  assert.equal(versionStateFromHealth({ version: TEMPLATES.vpn }, "vpn", TEMPLATES), "current");
  assert.equal(versionStateFromHealth({ version: "2026-11-10x" }, "vpn", TEMPLATES), "stale");
  // Sudah mengirim `type: "vpn"`: aturan yang sama, tanpa berubah.
  assert.equal(versionStateFromHealth({ type: "vpn", version: TEMPLATES.vpn }, "vpn", TEMPLATES), "current");
  assert.equal(versionStateFromHealth({ type: "vpn", version: "2026-11-10x" }, "vpn", TEMPLATES), "stale");
  assert.equal(versionStateFromHealth({ type: "VPn", version: TEMPLATES.vpn }, "vpn", TEMPLATES), "current");
});

test("versionStateFromHealth: kartu LB memakai versi LB — angkanya beda dengan versi VPN bukan 'lama'", () => {
  const templates = { vpn: "2026-11-20v", load_balancer: "2026-11-15a" };

  assert.equal(versionStateFromHealth({ type: "load_balancer", version: templates.load_balancer }, "load_balancer", templates), "current");
  assert.equal(versionStateFromHealth({ type: "load_balancer", version: templates.vpn }, "load_balancer", templates), "stale");
  // Inti permintaan: versi VPN yang BEDA tidak boleh membuat kartu LB dituduh versi lama.
  assert.equal(versionStateFromHealth({ version: "2026-11-20v" }, "load_balancer", templates), "stale");
  assert.equal(versionStateFromHealth({ version: "2026-11-15a" }, "load_balancer", templates), "current");
  // Jenis worker tak dikenal di state panel diperlakukan sebagai VPN (sama seperti typeLabel).
  assert.equal(versionStateFromHealth({ version: templates.vpn }, "aneh", templates), "current");
});

test("versionStateFromHealth: tipe tak dikenal / beda jenis / versi kosong => tidak diketahui", () => {
  // Template mengaku jenis lain dari kartunya: jangan menuduh versi lama.
  assert.equal(versionStateFromHealth({ type: "load_balancer", version: "2026-11-15a" }, "vpn", TEMPLATES), "unknown");
  assert.equal(versionStateFromHealth({ type: "vpn", version: "2026-11-15a" }, "load_balancer", TEMPLATES), "unknown");
  // Nilai `type` yang tidak dikenal panel.
  assert.equal(versionStateFromHealth({ type: "relay", version: "2026-11-15a" }, "vpn", TEMPLATES), "unknown");
  assert.equal(versionStateFromHealth({ type: "aneh", version: "2026-11-15a" }, "load_balancer", TEMPLATES), "unknown");
  // Tanpa versi (template LB lama menjawab teks biasa) tetap tidak diketahui, bukan "lama".
  assert.equal(versionStateFromHealth({ type: "load_balancer" }, "load_balancer", TEMPLATES), "unknown");
  assert.equal(versionStateFromHealth(null, "vpn", TEMPLATES), "unknown");
  assert.equal(versionStateFromHealth({ version: "2026-11-15a" }, "vpn", {}), "unknown", "versi template panel belum diketahui");
});

test("sampel menyimpan `type` dari /health supaya vonis versi bisa dihitung ulang dari cache", () => {
  const sample = healthSampleFromProbe({ at: T0, latencyMs: 20, status: 200, reachable: true, version: "2026-11-15a", type: "Load_Balancer" });
  assert.equal(sample.type, "load_balancer");

  const withoutType = healthSampleFromProbe({ at: T0, status: 200, reachable: true, version: "2026-11-15a" });
  assert.equal(withoutType.type, null);
  assert.equal(summarizeHealthHistory([withoutType]).lastType, null);

  const summary = summarizeHealthHistory([sample]);
  assert.equal(summary.lastType, "load_balancer");
  assert.equal(versionStateFromHealth({ type: summary.lastType, version: summary.lastVersion }, "load_balancer", TEMPLATES), "current");
  // Ringkasan uptime tidak berubah karena tambahan `type`.
  assert.equal(summary.uptimePct, 100);
  assert.equal(summary.avgLatencyMs, 20);
});

test("konstanta versi di panel sama dengan konstanta di template (VPN dan LB tidak bisa melenceng)", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const app = read("../frontend/app.js");
  const vpnTemplate = read("../frontend/source/panvlesscloudflare.js");
  const lbTemplate = read("../frontend/source/load-balancer.js");

  const constant = (source, name) => {
    const match = new RegExp("const " + name + ' = "([^"]+)"').exec(source);
    assert.ok(match, name + " tidak ditemukan");
    return match[1];
  };

  assert.equal(constant(app, "WORKER_TEMPLATE_VERSION"), constant(vpnTemplate, "WORKER_VERSION"));
  assert.equal(constant(app, "LB_TEMPLATE_VERSION"), constant(lbTemplate, "LB_VERSION"));
});

test("formatCheckedAt menuliskan umur pemeriksaan terakhir", () => {
  assert.equal(formatCheckedAt(null), "belum pernah");
  assert.equal(formatCheckedAt(T0, T0), "baru saja");
  assert.equal(formatCheckedAt(T0, T0 + 5_000), "baru saja");
  assert.equal(formatCheckedAt(T0, T0 + 30_000), "30 detik lalu");
  assert.equal(formatCheckedAt(T0, T0 + 60_000), "1 menit lalu");
  assert.equal(formatCheckedAt(T0, T0 + 3 * 3600_000), "3 jam lalu");
  assert.equal(formatCheckedAt(T0, T0 + 2 * 86400_000), "2 hari lalu");
  assert.equal(formatCheckedAt(T0 + 5000, T0), "baru saja", "jam yang mundur tidak menghasilkan angka negatif");
});

test("pruneHealthCache membuang worker yang sudah dihapus dan memangkas riwayat panjang", () => {
  const long = Array.from({ length: 30 }, (item, index) => ({ at: T0 + index, up: true, latencyMs: 10 }));
  const cache = { w1: long, w2: [{ at: T0, up: false, latencyMs: null }], w3: "rusak" };
  const kept = pruneHealthCache(cache, [{ id: "w1" }, { id: "w2" }]);

  assert.deepEqual(Object.keys(kept).sort(), ["w1", "w2"]);
  assert.equal(kept.w1.length, HEALTH_HISTORY_LIMIT);
  assert.equal(kept.w1[0].at, T0 + 10, "10 sampel tertua dipangkas");
  assert.equal(kept.w2.length, 1);
  assert.deepEqual(pruneHealthCache(null, [{ id: "w1" }]), {});
  assert.deepEqual(pruneHealthCache({ w1: [] }, null), {});
});

test("ringkasan cache end-to-end: sampel probe -> cache -> ringkasan kartu", () => {
  let cached = [];
  cached = appendHealthSample(cached, healthSampleFromProbe({ at: T0, latencyMs: 50, status: 200, reachable: true, version: "lama" }));
  cached = appendHealthSample(cached, healthSampleFromProbe({ at: T0 + 60_000, latencyMs: 70, status: 0, reachable: false, error: "Failed to fetch" }));

  const summary = summarizeHealthHistory(cached);
  assert.equal(summary.checks, 2);
  assert.equal(summary.uptimePct, 50);
  assert.equal(summary.lastUp, false);
  assert.equal(summary.lastError, "Failed to fetch");
  assert.equal(workerVersionState(summary.lastVersion, "2026-11-15a"), "unknown", "sampel terakhir tidak membawa versi");
});

test("token hasil rotasi (tombol Ganti token) yang tersimpan dipakai deploy batch & URL kartu", () => {
  const rotated = createSubToken((bytes) => bytes.fill(0xab));
  assert.equal(rotated, "ab".repeat(16));
  assert.match(rotated, /^[0-9a-f]{32}$/);

  const worker = {
    id: "w-lb",
    name: "cfvpn-lb",
    host: "lb.contoh.workers.dev",
    type: "load_balancer",
    vpn_domains: ["sg.contoh.workers.dev"],
    sub_token: "11111111111111111111111111111111",
  };
  const afterRotate = { ...worker, sub_token: rotated };

  // Deploy batch membaca token dari state: yang baru ikut ke worker, yang lama tidak.
  assert.equal(redeployVars(afterRotate).SUB_TOKEN, rotated);
  const url = withSubToken(`${afterRotate.host}/api/v1/sub?format=raw&limit=20`, afterRotate.sub_token);
  assert.ok(url.endsWith("t=" + rotated), "URL langganan kartu memakai token baru");
  assert.equal(url.includes(worker.sub_token), false, "token lama tidak boleh muncul lagi");
});

// --- (b) Pembuat permintaan statistik ---------------------------------------

test("endpoint GraphQL Cloudflare dan jendela bawaan", () => {
  assert.equal(STATS_ENDPOINT, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(STATS_DEFAULT_HOURS, 24);
  assert.equal(STATS_MAX_HOURS, 720);
  assert.equal(ANALYTICS_SCOPE_HINT, "Account Analytics: Read");
});

test("statsWindowHours: bawaan 24 jam, angka aneh kembali ke bawaan, nilai besar dibatasi", () => {
  assert.equal(statsWindowHours(undefined), 24);
  assert.equal(statsWindowHours(null), 24);
  assert.equal(statsWindowHours(""), 24);
  assert.equal(statsWindowHours("abc"), 24);
  assert.equal(statsWindowHours(0), 24);
  assert.equal(statsWindowHours(-5), 24);
  assert.equal(statsWindowHours("1"), 1);
  assert.equal(statsWindowHours(6.7), 6);
  assert.equal(statsWindowHours(24), 24);
  assert.equal(statsWindowHours(99_999), STATS_MAX_HOURS);
});

test("buildInvocationsQuery menyusun dataset, filter, dan jendela waktu yang benar", () => {
  const built = buildInvocationsQuery({ accountId: "acc-123", scriptName: "cfvpn-vpn-sg", hours: 6, nowMs: T0 });

  assert.equal(built.hours, 6);
  assert.equal(built.until, new Date(T0).toISOString());
  assert.equal(built.since, new Date(T0 - 6 * 3600 * 1000).toISOString());
  assert.equal(Date.parse(built.until) - Date.parse(built.since), 6 * 3600 * 1000);

  assert.match(built.query, /workersInvocationsAdaptive/);
  assert.match(built.query, /sum \{ requests errors \}/);
  assert.match(built.query, /datetime_geq: \$since/);
  assert.match(built.query, /datetime_leq: \$until/);
  assert.match(built.query, /accounts\(filter: \{ accountTag: \$accountTag \}\)/);

  assert.deepEqual(built.variables, {
    accountTag: "acc-123",
    scriptName: "cfvpn-vpn-sg",
    since: new Date(T0 - 6 * 3600 * 1000).toISOString(),
    until: new Date(T0).toISOString(),
  });
});

test("buildInvocationsQuery: jendela bawaan 24 jam kalau hours tidak diisi", () => {
  const built = buildInvocationsQuery({ accountId: "acc", scriptName: "cfvpn-lb", nowMs: T0 });
  assert.equal(built.hours, STATS_DEFAULT_HOURS);
  assert.equal(Date.parse(built.until) - Date.parse(built.since), 24 * 3600 * 1000);
});

test("nama script di-escape: nilai aneh tidak pernah masuk ke teks query", () => {
  const evil = 'x" }\n} evilScript #';
  const built = buildInvocationsQuery({ accountId: "acc", scriptName: evil, hours: 1, nowMs: T0 });

  assert.equal(built.variables.scriptName, evil.trim());
  assert.equal(built.query.includes("evilScript"), false, "nama script harus lewat variabel, bukan disisipkan ke query");
  assert.equal(built.query.includes(evil.trim()), false);

  // Body akhir dikirim sebagai JSON, jadi karakter khusus tersimpan sebagai escape sah.
  const body = JSON.stringify({ query: built.query, variables: built.variables });
  assert.equal(body.includes("\n"), false, "JSON.stringify tidak pernah mengirim baris baru mentah");
  assert.equal(body.includes('\\"'), true, "tanda kutip pada nama script harus ter-escape");
  assert.equal(JSON.parse(body).variables.scriptName, evil.trim());

  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed.variables).sort(), ["accountTag", "scriptName", "since", "until"]);
});

test("buildInvocationsQuery aman untuk masukan kosong/tipe lain", () => {
  const built = buildInvocationsQuery(undefined);
  assert.equal(built.variables.accountTag, "");
  assert.equal(built.variables.scriptName, "");
  assert.equal(built.hours, 24);
  assert.ok(Number.isFinite(Date.parse(built.since)));
});

// --- (c) Penanganan balasan Cloudflare yang bukan sukses --------------------

test("readInvocationsTotals menjumlahkan baris dan menolak bentuk yang tidak dikenal", () => {
  const totals = readInvocationsTotals({
    data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
      { sum: { requests: 1200, errors: 3 } },
      { sum: { requests: 40, errors: 1 } },
    ] }] } },
  });
  assert.deepEqual(totals, { requests: 1240, errors: 4, groups: 2 });

  assert.deepEqual(
    readInvocationsTotals({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }),
    { requests: 0, errors: 0, groups: 0 },
    "worker tanpa pemakaian memang 0 permintaan — itu jawaban sah, bukan angka karangan"
  );

  // Bentuk tidak dikenal -> null supaya pemanggil membalas gagal, bukan menampilkan 0.
  assert.equal(readInvocationsTotals(null), null);
  assert.equal(readInvocationsTotals({ data: { viewer: { accounts: [] } } }), null);
  assert.equal(readInvocationsTotals({ data: { viewer: { accounts: [{}] } } }), null);
  assert.equal(readInvocationsTotals({ data: null }), null);
});

test("cloudflareStatsError: 403 dan pesan soal izin menyebut kebutuhan Account Analytics: Read", () => {
  const forbidden = cloudflareStatsError(403, { errors: [{ code: 10000, message: "Authentication error" }] });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.needsScope, true);
  assert.match(forbidden.message, /Authentication error/);
  assert.match(forbidden.message, /Account Analytics: Read/);

  const scoped = cloudflareStatsError(200, { errors: [{ message: "you are not authorized to access this resource" }] });
  assert.equal(scoped.status, 403);
  assert.equal(scoped.needsScope, true);
  assert.match(scoped.message, /Account Analytics: Read/);

  const scopeWord = cloudflareStatsError(200, { error: "missing Account Analytics: Read permission" });
  assert.equal(scopeWord.status, 403);
  assert.equal(scopeWord.needsScope, true);
});

test("cloudflareStatsError: error biasa diteruskan apa adanya, 5xx jadi 502", () => {
  const bad = cloudflareStatsError(400, { errors: [{ message: "unknown field 'jumlah'" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.needsScope, false);
  assert.equal(bad.message, "unknown field 'jumlah'");

  const graph = cloudflareStatsError(200, { errors: [{ message: "invalid filter" }] });
  assert.equal(graph.status, 400);
  assert.match(graph.message, /invalid filter/);
  assert.equal(graph.needsScope, false);

  const boom = cloudflareStatsError(500, { errors: [{ message: "Internal error" }] });
  assert.equal(boom.status, 502);
  assert.match(boom.message, /Internal error/);

  const empty = cloudflareStatsError(403, null);
  assert.equal(empty.status, 403);
  assert.match(empty.message, /HTTP 403/);
  assert.match(empty.message, /Account Analytics: Read/);
});

// --- (d) Route POST /api/workers-stats dengan fetch distub ------------------

const CF_OK = {
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1234, errors: 12 } }] }] } },
};

// fetchStub mengganti fetch global di dalam satu uji. Permintaan ke GraphQL Cloudflare dijawab
// `handler`; URL lain (mis. RPC bump_rate) DILEMPAR supaya tidak pernah ada lalu lintas sungguhan
// ke Cloudflare/Supabase — checkGlobalRateLimit menangkap lemparan itu dan melewati pagar global,
// jadi hasil uji tidak bergantung pada jatah rate limit produksi.
function withFetchStub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  const stubFetch = async (url, options) => {
    const call = { url: String(url), options: options || {} };
    calls.push(call);
    if (call.url === STATS_ENDPOINT) return handler(call);
    throw new Error("permintaan tak terduga di dalam uji: " + call.url);
  };

  return {
    calls,
    // run memasang ulang stub SETIAP kali dipanggil (satu uji boleh memakai run beberapa kali)
    // dan selalu memulihkan fetch aslinya, termasuk saat uji gagal.
    async run(fn) {
      globalThis.fetch = stubFetch;
      try {
        return [await fn(calls), calls];
      } finally {
        globalThis.fetch = original;
      }
    },
  };
}

function statsRequest(body, headers) {
  return new Request("https://panel.test/api/workers-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...(headers || {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const FULL_BODY = {
  cfEmail: "admin@contoh.com",
  cfApiKey: "rahasia-global-key",
  accountId: "acc-123",
  scriptName: "cfvpn-vpn-sg",
  hours: 12,
};

test("route sukses: kredensial dikirim sebagai header, body GraphQL berisi variabel yang benar", async () => {
  const stub = withFetchStub(() =>
    new Response(JSON.stringify(CF_OK), { status: 200, headers: { "Content-Type": "application/json" } })
  );

  const [res] = await stub.run((calls) =>
    onRequest({ request: statsRequest(FULL_BODY), env: {} }).then((response) => {
      // Permintaan yang tercatat: hanya GraphQL Cloudflare (+ RPC rate limit yang gagal di stub).
      assert.ok(calls.every((call) => call.url === STATS_ENDPOINT || call.url.includes("/rpc/bump_rate")));
      return response;
    })
  );

  assert.equal(res.status, 200);
  const reply = await res.json();
  assert.equal(reply.success, true);
  assert.equal(reply.ok, true);
  assert.equal(reply.period, "hours");
  assert.equal(reply.hours, 12);
  assert.equal(reply.requests, 1234);
  assert.equal(reply.errors, 12);
  assert.equal(Date.parse(reply.to) - Date.parse(reply.from), 12 * 3600 * 1000);
  assert.equal(reply.quota, undefined, "tanpa dailyQuota tidak ada ringkasan kuota");

  const call = stub.calls.find((item) => item.url === STATS_ENDPOINT);
  assert.ok(call, "route harus memanggil endpoint GraphQL Cloudflare");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["X-Auth-Email"], "admin@contoh.com");
  assert.equal(call.options.headers["X-Auth-Key"], "rahasia-global-key");
  assert.equal(call.options.headers["Content-Type"], "application/json");

  const body = JSON.parse(call.options.body);
  assert.deepEqual(body.variables, {
    accountTag: "acc-123",
    scriptName: "cfvpn-vpn-sg",
    since: body.variables.since,
    until: body.variables.until,
  });
  assert.equal(Date.parse(body.variables.until) - Date.parse(body.variables.since), 12 * 3600 * 1000);
  assert.match(body.query, /workersInvocationsAdaptive/);
  assert.equal(body.query.includes("cfvpn-vpn-sg"), false, "nama script hanya lewat variabel");

});

test("route memakai jendela 24 jam kalau hours tidak dikirim", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_OK), { status: 200 }));
  const [res] = await stub.run(() =>
    onRequest({
      request: statsRequest({ ...FULL_BODY, hours: undefined }),
      env: {},
    })
  );

  assert.equal(res.status, 200);
  assert.equal((await res.json()).hours, 24);
  const body = JSON.parse(stub.calls.find((c) => c.url === STATS_ENDPOINT).options.body);
  assert.equal(Date.parse(body.variables.until) - Date.parse(body.variables.since), 24 * 3600 * 1000);
});

test("route menolak metode selain POST dengan 405 tanpa memanggil Cloudflare", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_OK), { status: 200 }));
  const [res] = await stub.run(() =>
    onRequest({ request: new Request("https://panel.test/api/workers-stats", { method: "GET" }), env: {} })
  );

  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: "Method not allowed" });
  assert.equal(stub.calls.length, 0, "GET tidak boleh menembak Cloudflare");
});

test("route menolak data kurang, JSON rusak, dan nama script tidak sah (400)", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_OK), { status: 200 }));

  const [missing] = await stub.run(() =>
    onRequest({ request: statsRequest({ cfEmail: "a@b.c", accountId: "acc" }), env: {} })
  );
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "Data Cloudflare tidak lengkap." });

  const [broken] = await stub.run(() => onRequest({ request: statsRequest("{bukan json"), env: {} }));
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: "Body JSON tidak valid." });

  const [badName] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...FULL_BODY, scriptName: "VPN SG 1" }), env: {} })
  );
  assert.equal(badName.status, 400);
  assert.match((await badName.json()).error, /Nama script tidak valid/);

  assert.equal(stub.calls.filter((call) => call.url === STATS_ENDPOINT).length, 0, "validasi gagal tidak menembak Cloudflare");
});

test("route meneruskan penolakan SEMUA scope sebagai 403 + petunjuk izin, tanpa mengarang angka", async () => {
  const stub = withFetchStub(() =>
    new Response(JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  );

  const [res] = await stub.run(() => onRequest({ request: statsRequest(FULL_BODY), env: {} }));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.success, undefined);
  assert.equal(body.requests, undefined, "gagal berarti tidak ada angka yang ditampilkan");
  assert.equal(body.needsScope, true);
  assert.match(body.error, /Account Analytics: Read/);
});

test("route membalas 400 saat GraphQL menjawab errors walau HTTP 200", async () => {
  const stub = withFetchStub(() =>
    new Response(JSON.stringify({ data: null, errors: [{ message: "invalid filter: scriptName" }] }), { status: 200 })
  );

  const [res] = await stub.run(() => onRequest({ request: statsRequest(FULL_BODY), env: {} }));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.needsScope, false);
  assert.match(body.error, /invalid filter: scriptName/);
});

test("route membalas 400 saat balasan Cloudflare tidak memuat data statistik", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), { status: 200 }));

  const [res] = await stub.run(() => onRequest({ request: statsRequest(FULL_BODY), env: {} }));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /workersInvocationsAdaptive/);
});

test("route membalas 500 saat permintaan ke Cloudflare gagal di jaringan", async () => {
  const stub = withFetchStub(() => {
    throw new Error("connect ECONNREFUSED");
  });

  const [res] = await stub.run(() => onRequest({ request: statsRequest(FULL_BODY), env: {} }));
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.match(body.error, /ECONNREFUSED/);
});

test("gerbang Origin: Origin yang tidak ada di ALLOWED_ORIGINS ditolak 403 sebelum apa pun", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_OK), { status: 200 }));

  const [res] = await stub.run(() =>
    onRequest({
      request: statsRequest(FULL_BODY, { Origin: "https://situs-asing.com" }),
      env: { ALLOWED_ORIGINS: "https://panel.contoh.com" },
    })
  );

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Origin tidak diizinkan." });
  assert.equal(stub.calls.length, 0);
});

// --- (e) Jendela "hari ini" (UTC), kuota harian, dan query ber-alias ---------

test("todayWindow: jendela hari ini selalu mulai 00:00:00Z, bukan tengah malam waktu lokal", () => {
  const noon = Date.parse("2026-11-16T13:45:12.000Z");
  const window = todayWindow(noon);
  assert.equal(window.since, "2026-11-16T00:00:00.000Z");
  assert.equal(window.until, "2026-11-16T13:45:12.000Z");

  // Tepat di tengah malam UTC: jendela kosong, bukan jendela 24 jam ke belakang.
  const midnight = Date.parse("2026-11-16T00:00:00.000Z");
  assert.deepEqual(todayWindow(midnight), {
    since: "2026-11-16T00:00:00.000Z",
    until: "2026-11-16T00:00:00.000Z",
  });

  // Lewat tengah malam berikutnya, tanggalnya ikut pindah.
  assert.equal(todayWindow(Date.parse("2026-11-17T00:00:01.000Z")).since, "2026-11-17T00:00:00.000Z");
});

test("summarizeQuota: aman <80%, peringatan 80-100%, bahaya >100%, sisa boleh negatif", () => {
  assert.deepEqual(summarizeQuota(0, 100000), { used: 0, quota: 100000, remaining: 100000, percent: 0, level: "ok" });
  assert.equal(summarizeQuota(79999, 100000).level, "ok");
  assert.equal(summarizeQuota(80000, 100000).level, "warn");
  assert.equal(summarizeQuota(80000, 100000).percent, 80);
  assert.equal(summarizeQuota(100000, 100000).level, "warn");
  assert.equal(summarizeQuota(100000, 100000).remaining, 0);

  const over = summarizeQuota(120000, 100000);
  assert.equal(over.level, "over");
  assert.equal(over.percent, 120);
  assert.equal(over.remaining, -20000, "kelebihan disebut apa adanya, bukan dipotong jadi 0");

  // Sedikit melewati kuota tetap bahaya walau persennya membulat ke 100.
  assert.equal(summarizeQuota(100001, 100000).level, "over");

  // Pemakaian pecahan dibulatkan ke bawah; kuota tidak sah berarti tidak diketahui.
  assert.equal(summarizeQuota(3.9, 10).used, 3);
  assert.deepEqual(summarizeQuota(5, 0), { used: 5, quota: null, remaining: null, percent: null, level: "unknown" });
  assert.equal(summarizeQuota(5, "bukan angka").level, "unknown");
  assert.equal(summarizeQuota(-4, 10).used, 0);
  assert.equal(DEFAULT_DAILY_QUOTA, 100000, "bawaan kuota = plan free 100.000 request/hari");
});

test("normalizeScriptNames: pangkas spasi, buang duplikat, tolak nama yang tidak sah", () => {
  assert.deepEqual(normalizeScriptNames([" vpn-a ", "vpn-b", "vpn-a", ""]), {
    names: ["vpn-a", "vpn-b"],
    rejected: [],
  });
  assert.deepEqual(normalizeScriptNames(["VPN SG 1", "vpn-ok"]), {
    names: ["vpn-ok"],
    rejected: ["VPN SG 1"],
  });
  assert.deepEqual(normalizeScriptNames(undefined), { names: [], rejected: [] });
  assert.deepEqual(normalizeScriptNames("vpn-a"), { names: ["vpn-a"], rejected: [] }, "satu nama juga diterima");
  assert.deepEqual(normalizeScriptNames([42, null]), { names: [], rejected: [] });
});

test("buildBatchInvocationsQuery: satu query dengan alias s0, s1, ... dan nama lewat variabel", () => {
  const built = buildBatchInvocationsQuery({
    accountId: "acc-123",
    scriptNames: ["vpn-a", "vpn-b", 'x" } evil'],
    period: "today",
    nowMs: T0,
  });

  assert.deepEqual(built.names, ["vpn-a", "vpn-b"], "nama tidak sah tidak ikut ke query");
  assert.deepEqual(built.aliases, { s0: "vpn-a", s1: "vpn-b" });
  assert.deepEqual(built.variables, {
    accountTag: "acc-123",
    s0: "vpn-a",
    s1: "vpn-b",
    since: todayWindow(T0).since,
    until: todayWindow(T0).until,
  });
  assert.equal(built.period, "today");
  assert.equal(built.hours, null);

  assert.match(built.query, /query WorkerInvocationsBatch\(\$accountTag: string!, \$s0: string!, \$s1: string!, \$since: Time!, \$until: Time!\)/);
  assert.match(built.query, /s0: workersInvocationsAdaptive\(limit: 1000, filter: \{ scriptName: \$s0, datetime_geq: \$since, datetime_leq: \$until \}\)/);
  assert.match(built.query, /s1: workersInvocationsAdaptive/);
  assert.equal(built.query.includes("vpn-a"), false, "nama script hanya lewat variabel");
  assert.equal(built.query.includes("evil"), false);
  assert.match(built.query, /sum \{ requests errors \}/);

  // Jendela jam tetap bisa dipakai dengan mode batch.
  const hourly = buildBatchInvocationsQuery({ accountId: "acc", scriptNames: ["a"], hours: 3, nowMs: T0 });
  assert.equal(hourly.hours, 3);
  assert.equal(Date.parse(hourly.until) - Date.parse(hourly.since), 3 * 3600 * 1000);
  // Satu panggilan saja: setiap panggilan mengambil waktu sekarang, jadi membandingkan dua
  // panggilan bisa meleset beberapa milidetik (tes ini pernah gagal acak karena itu).
  const empty = buildBatchInvocationsQuery(undefined);
  assert.equal(empty.variables.accountTag, "");
  assert.ok(Number.isFinite(Date.parse(empty.variables.since)));
  assert.equal(Date.parse(empty.variables.until) - Date.parse(empty.variables.since), 24 * 3600 * 1000, "masukan kosong tidak meledak");
});

test("readAliasedTotals: jumlahkan per alias, alias yang hilang jadi null", () => {
  const totals = readAliasedTotals(
    {
      data: {
        viewer: {
          accounts: [
            {
              s0: [{ sum: { requests: 300, errors: 3 } }, { sum: { requests: 20, errors: 1 } }],
              s1: [],
            },
          ],
        },
      },
    },
    { s0: "vpn-a", s1: "vpn-b", s2: "vpn-c" }
  );

  assert.deepEqual(totals, {
    "vpn-a": { requests: 320, errors: 4, groups: 2 },
    "vpn-b": { requests: 0, errors: 0, groups: 0 },
    "vpn-c": null,
  });
  assert.equal(readAliasedTotals({ data: { viewer: { accounts: [] } } }, { s0: "a" }), null);
  assert.equal(readAliasedTotals(null, { s0: "a" }), null);
  assert.equal(readAliasedTotals({ data: { viewer: { accounts: [{ s0: [] }] } } }, {}), null);
});

// Cloudflare menjawab satu alias per script; script tanpa pemakaian dibalas array kosong.
const CF_ALIASED = {
  data: {
    viewer: {
      accounts: [
        {
          s0: [{ sum: { requests: 500, errors: 2 } }],
          s1: [{ sum: { requests: 900, errors: 0 } }],
          s2: [{ sum: { requests: 1200, errors: 7 } }],
        },
      ],
    },
  },
};

const BATCH_BODY = {
  cfEmail: "admin@contoh.com",
  cfApiKey: "rahasia-global-key",
  accountId: "acc-123",
  period: "today",
  scriptNames: ["vpn-a", "vpn-b", "vpn-c"],
};

test("route period today (satu script): since = 00:00 UTC hari ini, balasan menyebut period/from/to", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_OK), { status: 200 }));
  const [res] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...FULL_BODY, period: "today" }), env: {} })
  );

  assert.equal(res.status, 200);
  const reply = await res.json();
  assert.equal(reply.success, true);
  assert.equal(reply.period, "today");
  assert.match(reply.from, /T00:00:00\.000Z$/, "jendela mulai tengah malam UTC");
  assert.equal(reply.from, todayWindow(Date.parse(reply.to)).since);
  assert.equal(reply.requests, 1234);
  assert.equal(reply.hours, undefined, "jendela hari ini bukan jendela jam");

  const body = JSON.parse(stub.calls.find((call) => call.url === STATS_ENDPOINT).options.body);
  assert.match(body.variables.since, /T00:00:00\.000Z$/);
  assert.match(body.query, /datetime_geq: \$since/);
  assert.equal(stub.calls.filter((call) => call.url === STATS_ENDPOINT).length, 1);
});

test("route scriptNames: SATU permintaan GraphQL ber-alias untuk semua worker", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_ALIASED), { status: 200 }));
  const [res] = await stub.run(() => onRequest({ request: statsRequest(BATCH_BODY), env: {} }));

  assert.equal(res.status, 200);
  const reply = await res.json();
  assert.equal(reply.ok, true);
  assert.equal(reply.period, "today");
  assert.equal(reply.workers, 3);
  assert.deepEqual(reply.results, {
    "vpn-a": { requests: 500, errors: 2 },
    "vpn-b": { requests: 900, errors: 0 },
    "vpn-c": { requests: 1200, errors: 7 },
  });
  assert.match(reply.from, /T00:00:00\.000Z$/);
  assert.equal(reply.quota, undefined, "tanpa dailyQuota tidak ada ringkasan kuota");

  const calls = stub.calls.filter((call) => call.url === STATS_ENDPOINT);
  assert.equal(calls.length, 1, "tiga worker tetap satu permintaan (jatah statistik 10/10 menit)");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.variables.s0, "vpn-a");
  assert.deepEqual(body.variables.s1, "vpn-b");
  assert.deepEqual(body.variables.s2, "vpn-c");
  assert.match(body.query, /s2: workersInvocationsAdaptive/);
  assert.equal(body.query.includes("vpn-c"), false);
  assert.equal(calls[0].options.headers["X-Auth-Email"], "admin@contoh.com");
});

test("route scriptNames + dailyQuota: ringkasan per worker dan total (kuota x jumlah worker)", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_ALIASED), { status: 200 }));
  const [res] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, dailyQuota: 1000 }), env: {} })
  );

  const reply = await res.json();
  assert.equal(res.status, 200);
  assert.equal(reply.dailyQuota, 1000);
  assert.deepEqual(reply.quota, {
    "vpn-a": { used: 500, quota: 1000, remaining: 500, percent: 50, level: "ok" },
    "vpn-b": { used: 900, quota: 1000, remaining: 100, percent: 90, level: "warn" },
    "vpn-c": { used: 1200, quota: 1000, remaining: -200, percent: 120, level: "over" },
  });
  assert.deepEqual(reply.total, { used: 2600, quota: 3000, remaining: 400, percent: 86.7, level: "warn", workers: 3 });
});

test("route scriptNames: kuota diabaikan untuk jendela jam, isian kuota tidak sah bukan 0", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_ALIASED), { status: 200 }));

  const [hourly] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, period: "hours", hours: 6, dailyQuota: 1000 }), env: {} })
  );
  const hourlyReply = await hourly.json();
  assert.equal(hourlyReply.period, "hours");
  assert.equal(hourlyReply.hours, 6);
  assert.equal(hourlyReply.quota, undefined);

  const [bogus] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, dailyQuota: "abc" }), env: {} })
  );
  assert.equal((await bogus.json()).quota, undefined, "kuota tidak sah tidak diganti angka karangan");
});

test("route scriptNames: validasi daftar nama (kosong, tidak sah, lebih dari batas)", async () => {
  const stub = withFetchStub(() => new Response(JSON.stringify(CF_ALIASED), { status: 200 }));

  const [empty] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, scriptNames: [] }), env: {} })
  );
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "Daftar scriptNames kosong." });

  const [badName] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, scriptNames: ["vpn-a", "VPN SG 1"] }), env: {} })
  );
  assert.equal(badName.status, 400);
  assert.match((await badName.json()).error, /Nama script tidak valid: "VPN SG 1"/);

  const tooMany = Array.from({ length: STATS_MAX_SCRIPTS + 1 }, (item, index) => `w-${index}`);
  const [over] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, scriptNames: tooMany }), env: {} })
  );
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, new RegExp(`Maksimal ${STATS_MAX_SCRIPTS} script`));

  assert.equal(stub.calls.filter((call) => call.url === STATS_ENDPOINT).length, 0, "validasi gagal tidak menembak Cloudflare");
});

test("route scriptNames meneruskan 403 Cloudflare sebagai pesan izin Analytics", async () => {
  const stub = withFetchStub(() =>
    new Response(JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  );

  const [res] = await stub.run(() =>
    onRequest({ request: statsRequest({ ...BATCH_BODY, dailyQuota: 1000 }), env: {} })
  );
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.needsScope, true);
  assert.equal(body.results, undefined, "tidak ada angka karangan saat izin kurang");
  assert.equal(body.quota, undefined);
  assert.match(body.error, /Account Analytics: Read/);
});

test("route scriptNames membalas 400 saat sebuah alias tidak ada di balasan Cloudflare", async () => {
  const partial = { data: { viewer: { accounts: [{ s0: [{ sum: { requests: 5, errors: 0 } }] }] } } };
  const stub = withFetchStub(() => new Response(JSON.stringify(partial), { status: 200 }));

  const [res] = await stub.run(() => onRequest({ request: statsRequest(BATCH_BODY), env: {} }));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /vpn-b, vpn-c/);
  assert.equal(body.results, undefined);
});
