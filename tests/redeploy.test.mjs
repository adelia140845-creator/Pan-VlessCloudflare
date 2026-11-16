// Uji logika murni tombol "Deploy ulang semua Worker tersimpan" (frontend/redeploy.js).
// Tanpa DOM, tanpa jaringan, tanpa Cloudflare sungguhan.
// Jalankan: node --test tests/redeploy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  REDEPLOY_TEMPLATES,
  SUB_TOKEN_BYTES,
  createSubToken,
  ensureSubToken,
  redeployVars,
  redeployPlan,
  redeployProgressLine,
  rateLimitInfo,
  summarizeRedeploy,
  withSubToken,
  quotaGate,
  groupUsageByAccount,
  clampQuotaThreshold,
  ACCOUNT_QUOTA_THRESHOLD_DEFAULT,
  ACCOUNT_QUOTA_THRESHOLD_MIN,
  ACCOUNT_QUOTA_THRESHOLD_MAX,
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

// --- token langganan Load Balancer ------------------------------------------

test("createSubToken menghasilkan 32 karakter hex dari 16 byte acak", () => {
  assert.equal(SUB_TOKEN_BYTES, 16);
  assert.equal(createSubToken().length, 32);
  assert.match(createSubToken(), /^[0-9a-f]{32}$/);

  // Sumber acak disuntik: byte 0..15 -> "000102...0f" (menunjukkan hex dua digit dipertahankan).
  const token = createSubToken((bytes) => bytes.forEach((_, i) => { bytes[i] = i; }));
  assert.equal(token, "000102030405060708090a0b0c0d0e0f");
  assert.equal(token.length, 32);
});

test("createSubToken memakai crypto.getRandomValues sungguhan dan tidak pernah sama dua kali", () => {
  assert.notEqual(createSubToken(), createSubToken());
});

test("ensureSubToken idempoten: token yang sudah tersimpan dipakai apa adanya", () => {
  const stored = "a".repeat(32);
  assert.equal(ensureSubToken({ sub_token: stored }), stored);
  assert.equal(ensureSubToken({ sub_token: `  ${stored}  ` }), stored);
});

test("ensureSubToken hanya membuat token baru kalau belum ada / tidak sah", () => {
  const rng = (bytes) => bytes.fill(0xab);
  assert.equal(ensureSubToken({ type: "load_balancer" }, rng), "ab".repeat(16));
  assert.equal(ensureSubToken({ sub_token: "   " }, rng), "ab".repeat(16));
  assert.equal(ensureSubToken({ sub_token: 123 }, rng), "ab".repeat(16));
  assert.equal(ensureSubToken(undefined, rng), "ab".repeat(16));
});

test("withSubToken menyisipkan t= pada URL langganan", () => {
  assert.equal(
    withSubToken("https://lb.workers.dev/api/v1/sub?format=raw&limit=20&domains=a,b", "tok123"),
    "https://lb.workers.dev/api/v1/sub?format=raw&limit=20&domains=a,b&t=tok123"
  );
  assert.equal(withSubToken("https://lb.workers.dev/api/v1/sub", " tok123 "), "https://lb.workers.dev/api/v1/sub?t=tok123");
  // Kartu worker menampilkan URL tanpa skema: tetap harus kena.
  assert.equal(withSubToken("lb.workers.dev/api/v1/sub?limit=20", "tok123"), "lb.workers.dev/api/v1/sub?limit=20&t=tok123");
});

test("withSubToken tidak menulis t= dua kali dan aman untuk masukan kosong", () => {
  const withToken = "https://lb.workers.dev/api/v1/sub?format=raw&t=tok123";
  assert.equal(withSubToken(withToken, "tok123"), withToken);
  assert.equal(withSubToken("https://lb.workers.dev/api/v1/sub?t=lama", "baru"), "https://lb.workers.dev/api/v1/sub?t=lama");

  assert.equal(withSubToken("https://lb.workers.dev/api/v1/sub", ""), "https://lb.workers.dev/api/v1/sub");
  assert.equal(withSubToken("https://lb.workers.dev/api/v1/sub", undefined), "https://lb.workers.dev/api/v1/sub");
  assert.equal(withSubToken("https://lb.workers.dev/api/v1/sub", "   "), "https://lb.workers.dev/api/v1/sub");
  assert.equal(withSubToken("", "tok123"), "");
  assert.equal(withSubToken(null, "tok123"), null);
});

test("vars Load Balancer membawa SUB_TOKEN hanya kalau worker punya token tersimpan", () => {
  assert.deepEqual(redeployVars({ type: "load_balancer", vpn_domains: ["sg.workers.dev"] }), {
    VPN_DOMAINS_FREE: "sg.workers.dev",
  });
  assert.deepEqual(redeployVars({ type: "load_balancer", sub_token: "tok123", vpn_domains: ["sg.workers.dev"] }), {
    VPN_DOMAINS_FREE: "sg.workers.dev",
    SUB_TOKEN: "tok123",
  });
  assert.deepEqual(redeployVars({ type: "load_balancer", sub_token: " tok123 " }), { SUB_TOKEN: "tok123" });
  assert.deepEqual(redeployVars({ type: "load_balancer", sub_token: "  " }), {});
  assert.deepEqual(redeployVars({ type: "load_balancer", sub_token: 123 }), {});
  // VPN tidak pernah mengirim SUB_TOKEN walau state kebetulan punya fieldnya.
  assert.deepEqual(redeployVars({ type: "vpn", sub_token: "tok123", uuid: UUID }), { UUID_ALLOWLIST: UUID });
});

test("batch redeploy memakai token tersimpan, tanpa membuat token baru", () => {
  const plan = redeployPlan([
    { id: "lb1", name: "cfvpn-lb", type: "load_balancer", vpn_domains: ["sg.workers.dev"], sub_token: "simpan123" },
    { id: "lb2", name: "cfvpn-lb-lama", type: "load_balancer", vpn_domains: ["sg.workers.dev"] },
  ]);

  assert.deepEqual(plan[0].vars, { VPN_DOMAINS_FREE: "sg.workers.dev", SUB_TOKEN: "simpan123" });
  assert.deepEqual(plan[1].vars, { VPN_DOMAINS_FREE: "sg.workers.dev" });
  // Rencananya tidak menulis apa pun ke state: token lama tetap utuh.
  assert.equal(redeployPlan([{ name: "x", type: "load_balancer", sub_token: "simpan123" }])[0].vars.SUB_TOKEN, "simpan123");
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

// --- penjaga kuota per akun (gate 90%) --------------------------------------

test("gate di bawah ambang: 85% belum diblokir", () => {
  const gate = quotaGate({ used: 85000, quota: 100000, threshold: 90 });

  assert.equal(gate.blocked, false);
  assert.equal(gate.percent, 85);
  assert.equal(gate.remaining, 15000);
  assert.equal(gate.level, "warn");
});

test("gate tepat di ambang: 90% diblokir (>= ambang, bukan >)", () => {
  const gate = quotaGate({ used: 90000, quota: 100000, threshold: 90 });

  assert.equal(gate.percent, 90);
  assert.equal(gate.blocked, true);
  assert.equal(gate.remaining, 10000);
  assert.equal(gate.level, "warn");
});

test("gate di atas ambang: 95% diblokir, 120% berlevel over dengan sisa negatif", () => {
  const above = quotaGate({ used: 95000, quota: 100000, threshold: 90 });
  assert.equal(above.blocked, true);
  assert.equal(above.percent, 95);
  assert.equal(above.remaining, 5000);

  const over = quotaGate({ used: 120000, quota: 100000, threshold: 90 });
  assert.equal(over.blocked, true);
  assert.equal(over.percent, 120);
  assert.equal(over.remaining, -20000);
  assert.equal(over.level, "over");
});

test("gate memakai ambang bawaan 90% saat threshold tidak diisi", () => {
  assert.equal(quotaGate({ used: 89000, quota: 100000 }).blocked, false);
  assert.equal(quotaGate({ used: 90000, quota: 100000 }).blocked, true);
  assert.equal(quotaGate({ used: 90000, quota: 100000, threshold: null }).blocked, true);
});

test("gate data tidak sah tidak memblokir apa pun dan berlevel unknown", () => {
  const inputs = [
    undefined,
    null,
    {},
    { used: 0, quota: 0 },
    { used: 500, quota: -1 },
    { used: -5, quota: 100 },
    { used: "abc", quota: 100 },
    { used: 10, quota: "x" },
  ];

  for (const input of inputs) {
    const gate = quotaGate(input);
    assert.equal(gate.blocked, false, `input ${JSON.stringify(input)} tidak boleh memblokir`);
    assert.equal(gate.level, "unknown");
    assert.equal(gate.percent, null);
    assert.equal(gate.remaining, null);
  }
});

test("threshold dijepit ke 50-100 dan nilai rusak kembali ke bawaan 90", () => {
  assert.equal(ACCOUNT_QUOTA_THRESHOLD_DEFAULT, 90);
  assert.equal(ACCOUNT_QUOTA_THRESHOLD_MIN, 50);
  assert.equal(ACCOUNT_QUOTA_THRESHOLD_MAX, 100);

  assert.equal(clampQuotaThreshold(10), 50);
  assert.equal(clampQuotaThreshold(0), 50);
  assert.equal(clampQuotaThreshold(500), 100);
  assert.equal(clampQuotaThreshold("75"), 75);
  assert.equal(clampQuotaThreshold(""), 90);
  assert.equal(clampQuotaThreshold(null), 90);
  assert.equal(clampQuotaThreshold("abc"), 90);
});

test("gate ikut menjepit threshold: ambang 500 berarti 100%, bukan mustahil tercapai", () => {
  assert.equal(quotaGate({ used: 99000, quota: 100000, threshold: 500 }).blocked, false);
  assert.equal(quotaGate({ used: 100000, quota: 100000, threshold: 500 }).blocked, true);
  // Ambang 10 dijepit ke 50: pemakaian 40% tidak diblokir.
  assert.equal(quotaGate({ used: 40000, quota: 100000, threshold: 10 }).blocked, false);
});

test("agregasi per akun menjumlahkan worker satu akun dan memakai fallback untuk worker tanpa accountId", () => {
  const workers = [
    { id: "w1", name: "vpn-a1", accountId: "acc-a" },
    { id: "w2", name: "vpn-a2", accountId: "acc-a" },
    { id: "w3", name: "lb-a", accountId: "acc-a", type: "load_balancer" },
    { id: "w4", name: "vpn-lama" },
  ];
  const results = {
    "vpn-a1": { requests: 40000, errors: 3 },
    "vpn-a2": { requests: 35000, errors: 0 },
    "lb-a": { requests: 12000, errors: 1 },
    "vpn-lama": { requests: 3000, errors: 0 },
  };

  const groups = groupUsageByAccount(workers, results, "acc-fallback");

  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get("acc-a").workers.map((worker) => worker.id), ["w1", "w2", "w3"]);
  assert.equal(groups.get("acc-a").used, 87000);
  assert.equal(groups.get("acc-a").errors, 4);

  assert.deepEqual(groups.get("acc-fallback").workers.map((worker) => worker.id), ["w4"]);
  assert.equal(groups.get("acc-fallback").used, 3000);
  // 87% dari 100.000 -> per worker "aman", per akun hampir kena ambang.
  assert.equal(quotaGate({ used: groups.get("acc-a").used, quota: 100000, threshold: 90 }).blocked, false);
  assert.equal(quotaGate({ used: groups.get("acc-a").used + 3000, quota: 100000, threshold: 90 }).blocked, true);
});

test("worker dari akun lain tidak tercampur, dan worker tanpa hasil dihitung 0 request", () => {
  const workers = [
    { id: "w1", name: "vpn-a", accountId: "acc-a" },
    { id: "w2", name: "vpn-b", accountId: "acc-b" },
    { id: "w3", name: "vpn-x", accountId: "acc-b" },
  ];

  const groups = groupUsageByAccount(workers, { "vpn-a": { requests: 90000 }, "vpn-b": { requests: 1000 } }, "acc-fallback");

  assert.equal(groups.size, 2);
  assert.equal(groups.get("acc-a").used, 90000);
  assert.equal(groups.get("acc-b").used, 1000);
  assert.deepEqual(groups.get("acc-b").workers.map((worker) => worker.id), ["w2", "w3"]);
  assert.equal(groups.has("acc-fallback"), false);

  // Gate diputuskan per akun: akun A diblokir, akun B tidak, walau hasil mentahnya satu panggilan.
  assert.equal(quotaGate({ used: groups.get("acc-a").used, quota: 100000, threshold: 90 }).blocked, true);
  assert.equal(quotaGate({ used: groups.get("acc-b").used, quota: 100000, threshold: 90 }).blocked, false);
});

test("worker tanpa accountId dan tanpa fallback tidak dimasukkan ke akun mana pun", () => {
  assert.equal(groupUsageByAccount([{ id: "w1", name: "vpn-x" }], { "vpn-x": { requests: 5000 } }, "   ").size, 0);
  assert.equal(groupUsageByAccount([{ id: "w1", name: "vpn-x" }], { "vpn-x": { requests: 5000 } }, undefined).size, 0);
});

test("groupUsageByAccount aman untuk masukan kosong/rusak", () => {
  assert.equal(groupUsageByAccount(undefined, undefined, undefined).size, 0);
  assert.equal(groupUsageByAccount([null, "x", 3, {}], "bukan objek", null).size, 0);
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
