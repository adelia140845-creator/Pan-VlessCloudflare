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
  ANALYTICS_SCOPE_HINT,
  statsWindowHours,
  buildInvocationsQuery,
  readInvocationsTotals,
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
  assert.deepEqual(await res.json(), { success: true, requests: 1234, errors: 12, hours: 12 });

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
