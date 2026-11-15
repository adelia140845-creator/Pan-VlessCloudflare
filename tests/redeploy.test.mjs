// Uji logika murni tombol "Deploy ulang semua Worker tersimpan" (frontend/redeploy.js).
// Tanpa DOM, tanpa jaringan, tanpa Cloudflare sungguhan.
// Jalankan: node --test tests/redeploy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  REDEPLOY_TEMPLATES,
  redeployVars,
  redeployPlan,
  redeployProgressLine,
  rateLimitInfo,
  summarizeRedeploy,
} from "../frontend/redeploy.js";

const UUID = "14df7aee-0416-45a8-a651-e69de188deca";

const WORKERS = [
  { id: "w1", name: "cfvpn-vpn-sg", host: "sg.workers.dev", type: "vpn", active: true, uuid: UUID },
  { id: "w2", name: "cfvpn-lb", host: "lb.workers.dev", type: "load_balancer", active: true, vpn_domains: ["sg.workers.dev", " jp.workers.dev "] },
  { id: "w3", name: "cfvpn-vpn-jp", host: "jp.workers.dev", type: "vpn", active: false },
];

// --- redeployPlan -----------------------------------------------------------

test("plan mengikuti urutan state, memakai template per jenis, dan membawa vars per worker", () => {
  const plan = redeployPlan(WORKERS);

  assert.deepEqual(plan.map((step) => step.name), ["cfvpn-vpn-sg", "cfvpn-lb", "cfvpn-vpn-jp"]);
  assert.deepEqual(plan.map((step) => step.id), ["w1", "w2", "w3"]);

  assert.equal(plan[0].type, "vpn");
  assert.equal(plan[0].template, "/source/panvlesscloudflare.js");
  assert.deepEqual(plan[0].vars, { UUID_ALLOWLIST: UUID });

  assert.equal(plan[1].type, "load_balancer");
  assert.equal(plan[1].template, REDEPLOY_TEMPLATES.load_balancer);
  assert.equal(plan[1].template, "/source/load-balancer.js");
  assert.deepEqual(plan[1].vars, { VPN_DOMAINS_FREE: "sg.workers.dev,jp.workers.dev" });

  // VPN tanpa UUID tersimpan: worker terbuka, jadi tidak ada binding sama sekali.
  assert.deepEqual(plan[2].vars, {});
});

test("plan melewati entri rusak (tanpa nama) dan menormalkan jenis yang tidak dikenal ke VPN", () => {
  const plan = redeployPlan([
    null,
    undefined,
    { id: "x", name: "   " },
    { name: "cfvpn-vpn-x", type: "aneh" },
    "bukan-objek",
  ]);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, "cfvpn-vpn-x");
  assert.equal(plan[0].id, null);
  assert.equal(plan[0].type, "vpn");
  assert.equal(plan[0].template, REDEPLOY_TEMPLATES.vpn);
});

test("plan dari state kosong / bukan array tetap array kosong (loop tidak jalan)", () => {
  assert.deepEqual(redeployPlan([]), []);
  assert.deepEqual(redeployPlan(undefined), []);
  assert.deepEqual(redeployPlan({ workers: WORKERS }), []);
});

// --- redeployVars -----------------------------------------------------------

test("vars Load Balancer hanya memuat domain yang benar-benar ada", () => {
  assert.deepEqual(redeployVars({ type: "load_balancer" }), {});
  assert.deepEqual(redeployVars({ type: "load_balancer", vpn_domains: [] }), {});
  assert.deepEqual(redeployVars({ type: "load_balancer", vpn_domains: ["  ", ""] }), {});
  assert.deepEqual(redeployVars({ type: "load_balancer", vpn_domains: "sg.workers.dev" }), {});
  assert.deepEqual(redeployVars({ type: "load_balancer", vpn_domains: ["sg.workers.dev"] }), {
    VPN_DOMAINS_FREE: "sg.workers.dev",
  });
});

test("vars Load Balancer ikut mengunci UUID kalau worker menyimpannya", () => {
  assert.deepEqual(
    redeployVars({ type: "load_balancer", uuid: UUID, vpn_domains: ["sg.workers.dev"] }),
    { UUID_ALLOWLIST: UUID, VPN_DOMAINS_FREE: "sg.workers.dev" }
  );
});

test("UUID kosong/bertipe lain tidak dipasang sebagai binding", () => {
  assert.deepEqual(redeployVars({ type: "vpn" }), {});
  assert.deepEqual(redeployVars({ type: "vpn", uuid: "   " }), {});
  assert.deepEqual(redeployVars({ type: "vpn", uuid: 123 }), {});
  assert.deepEqual(redeployVars(null), {});
});

// --- redeployProgressLine ---------------------------------------------------

test("baris progres menampilkan nomor, nama, dan hasil per worker", () => {
  assert.equal(redeployProgressLine(3, 12, "cfvpn-vpn-sg", null), "deploy 3/12: cfvpn-vpn-sg — mengirim template...");
  assert.equal(redeployProgressLine(3, 12, "cfvpn-vpn-sg", { ok: true }), "deploy 3/12: cfvpn-vpn-sg — sukses");
  assert.equal(
    redeployProgressLine(4, 12, "cfvpn-lb", { ok: false, error: "Deploy gagal (HTTP 500)" }),
    "deploy 4/12: cfvpn-lb — gagal (Deploy gagal (HTTP 500))"
  );
  assert.equal(redeployProgressLine(5, 12, "cfvpn-vpn-jp", { ok: false }), "deploy 5/12: cfvpn-vpn-jp — gagal (alasan tidak diketahui)");
});

// --- rateLimitInfo ----------------------------------------------------------

test("status selain 429 bukan rate limit", () => {
  assert.deepEqual(rateLimitInfo(200, null, { success: true }), { limited: false, retryAfter: null });
  assert.deepEqual(rateLimitInfo(500, "600", { error: "boom" }), { limited: false, retryAfter: null });
});

test("429 mengambil Retry-After dari header", () => {
  assert.deepEqual(rateLimitInfo(429, "600", { error: "Terlalu banyak permintaan." }), { limited: true, retryAfter: 600 });
  assert.deepEqual(rateLimitInfo(429, "45", null), { limited: true, retryAfter: 45 });
});

test("429 tanpa header yang sah jatuh ke teks pesan, lalu ke null", () => {
  assert.deepEqual(
    rateLimitInfo(429, null, { error: "Terlalu banyak permintaan. Coba lagi dalam 300 detik." }),
    { limited: true, retryAfter: 300 }
  );
  assert.deepEqual(rateLimitInfo(429, "abc", { error: "Terlalu banyak permintaan." }), { limited: true, retryAfter: null });
  assert.deepEqual(rateLimitInfo(429, "0", null), { limited: true, retryAfter: null });
  assert.deepEqual(rateLimitInfo(429, undefined, undefined), { limited: true, retryAfter: null });
});

// --- summarizeRedeploy ------------------------------------------------------

test("ringkasan saat semua worker sukses", () => {
  const summary = summarizeRedeploy([{ name: "a", ok: true }, { name: "b", ok: true }, { name: "c", ok: true }], 3);

  assert.equal(summary.message, "Ringkasan: 3 sukses, 0 gagal.");
  assert.equal(summary.ok, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.stopped, false);
  assert.deepEqual(summary.failedNames, []);
});

test("429 di worker ke-3 menghentikan loop: sukses tetap dihitung, sisanya dilewati", () => {
  const results = [
    { name: "a", ok: true },
    { name: "b", ok: true },
    { name: "c", ok: false, limited: true, retryAfter: 600, error: "Terlalu banyak permintaan." },
  ];
  const summary = summarizeRedeploy(results, 5);

  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.sent, 3);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.stopped, true);
  assert.equal(summary.retryAfter, 600);
  assert.match(summary.message, /^Ringkasan: 2 sukses, 0 gagal\./);
  assert.match(summary.message, /Sisanya \(2 worker\) dilewati karena limit 10 permintaan\/10 menit/);
  assert.match(summary.message, /coba lagi setelah 600 detik/);
});

test("429 di worker pertama: tidak ada sukses, sisanya dilewati", () => {
  const summary = summarizeRedeploy([{ name: "a", ok: false, limited: true, retryAfter: null }], 4);

  assert.equal(summary.ok, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 3);
  assert.match(summary.message, /^Ringkasan: 0 sukses, 0 gagal\./);
  assert.match(summary.message, /Sisanya \(3 worker\) dilewati/);
  assert.match(summary.message, /coba lagi setelah jendela rate limit lewat/);
});

test("worker gagal dilaporkan dengan namanya beserta alasan", () => {
  const summary = summarizeRedeploy(
    [
      { name: "cfvpn-vpn-sg", ok: true },
      { name: "cfvpn-lb", ok: false, error: "Deploy gagal (HTTP 500)" },
    ],
    2
  );

  assert.equal(summary.failed, 1);
  assert.equal(summary.stopped, false);
  assert.deepEqual(summary.failedNames, ["cfvpn-lb"]);
  assert.match(summary.message, /1 sukses, 1 gagal/);
  assert.match(summary.message, /Gagal: cfvpn-lb \(Deploy gagal \(HTTP 500\)\)\./);
  assert.equal(summary.message.includes("dilewati"), false);
});

test("daftar gagal dipotong setelah 5 nama tapi jumlahnya tetap benar", () => {
  const results = Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, ok: false, error: "gagal" }));
  const summary = summarizeRedeploy(results, 6);

  assert.equal(summary.failed, 6);
  assert.equal(summary.failedNames.length, 6);
  assert.match(summary.message, /\+1 gagal lain/);
  assert.equal(summary.message.match(/\(gagal\)/g).length, 5);
});

test("hasil kosong / bukan array tetap menghasilkan ringkasan yang jujur", () => {
  assert.equal(summarizeRedeploy([], 0).message, "Ringkasan: 0 sukses, 0 gagal.");
  assert.equal(summarizeRedeploy(undefined).message, "Ringkasan: 0 sukses, 0 gagal.");
});

test("plannedTotal yang lebih kecil dari jumlah hasil tidak membuat skipped negatif", () => {
  const summary = summarizeRedeploy(
    [{ name: "a", ok: true }, { name: "b", ok: false, limited: true, retryAfter: 10 }],
    1
  );
  assert.equal(summary.planned, 2);
  assert.equal(summary.skipped, 0);
});

// --- pagar parse modul ------------------------------------------------------

test("app.js masih modul yang bisa di-parse: gagalnya hanya di impor CDN, bukan SyntaxError", async () => {
  const error = await import("../frontend/app.js").then(
    () => null,
    (err) => err
  );

  assert.ok(error, "impor app.js di Node seharusnya gagal karena impor https:// (CDN)");
  assert.equal(error instanceof SyntaxError, false, `app.js gagal di-parse: ${error && error.message}`);
  assert.notEqual(String(error.code), "ERR_INVALID_SYNTAX", `app.js gagal di-parse: ${error && error.message}`);
});
