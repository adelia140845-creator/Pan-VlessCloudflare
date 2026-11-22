// Uji riwayat kesehatan worker (/health) dan drift konstanta versi panel/template.
//
//  (a) helper murni ringkasan uptime dari cache (frontend/redeploy.js),
//  (b) token langganan LB hasil rotasi dipakai deploy batch & URL kartu,
//  (c) drift konstanta WORKER_VERSION/WORKER_TEMPLATE_VERSION dan LB_VERSION/LB_TEMPLATE_VERSION
//      supaya konstanta panel dan template tidak bisa melenceng.
//
// Jalankan: node --test tests/health-history.test.mjs
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
