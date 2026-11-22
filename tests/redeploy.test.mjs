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
  subUrlUuid,
  cfSecretNeedsEmail,
  parseWorkerEdit,
  parseWorkerBatch,
  parseSubToken,
  hostFromInput,
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
  assert.deepEqual(plan[1].vars, { VPN_DOMAINS: "sg.workers.dev,jp.workers.dev" });

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
    VPN_DOMAINS: "sg.workers.dev",
  });
});

test("vars Load Balancer ikut mengunci UUID kalau worker menyimpannya", () => {
  assert.deepEqual(
    redeployVars({ type: "load_balancer", uuid: UUID, vpn_domains: ["sg.workers.dev"] }),
    { UUID_ALLOWLIST: UUID, VPN_DOMAINS: "sg.workers.dev" }
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
    VPN_DOMAINS: "sg.workers.dev",
  });
  assert.deepEqual(redeployVars({ type: "load_balancer", sub_token: "tok123", vpn_domains: ["sg.workers.dev"] }), {
    VPN_DOMAINS: "sg.workers.dev",
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

  assert.deepEqual(plan[0].vars, { VPN_DOMAINS: "sg.workers.dev", SUB_TOKEN: "simpan123" });
  assert.deepEqual(plan[1].vars, { VPN_DOMAINS: "sg.workers.dev" });
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

test("subUrlUuid: semua domain tercatat dengan UUID sama -> UUID itu", () => {
  const workers = [{ host: "vpn-a.workers.dev", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }];
  assert.equal(subUrlUuid(["vpn-a.workers.dev"], workers), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(subUrlUuid(["VPN-A.Workers.dev"], workers), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "host tidak peka huruf");
});

test("subUrlUuid: satu domain tanpa UUID atau tidak dikenal -> kosong (jangan menebak)", () => {
  const workers = [{ host: "vpn-a.workers.dev", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { host: "vpn-b.workers.dev" }];
  assert.equal(subUrlUuid(["vpn-a.workers.dev", "vpn-b.workers.dev"], workers), "");
  assert.equal(subUrlUuid(["vpn-c.workers.dev"], workers), "");
  assert.equal(subUrlUuid(["vpn-a.workers.dev"], [{ host: "vpn-a.workers.dev", uuid: "bukan-uuid" }]), "");
});

test("subUrlUuid: UUID berbeda antar domain atau domain kosong -> kosong", () => {
  const workers = [
    { host: "vpn-a.workers.dev", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { host: "vpn-b.workers.dev", uuid: "11111111-2222-4333-8444-555555555555" },
  ];
  assert.equal(subUrlUuid(["vpn-a.workers.dev", "vpn-b.workers.dev"], workers), "");
  assert.equal(subUrlUuid([], workers), "");
  assert.equal(subUrlUuid(null, workers), "");
});

test("cfSecretNeedsEmail: token cfut_ tidak butuh email, Global API Key butuh", () => {
  assert.equal(cfSecretNeedsEmail("cfut_abc123"), false);
  assert.equal(cfSecretNeedsEmail("  CFUT_abc  "), false, "awalan token tidak peka huruf");
  assert.equal(cfSecretNeedsEmail("0123456789abcdef0123456789abcdef01234"), true);
  assert.equal(cfSecretNeedsEmail(""), true, "kosong dianggap butuh email (validasi route yang menolak)");
});

// --- parseWorkerEdit / parseSubToken (validasi form worker) -----------------

test("parseWorkerEdit: worker VPN sah dinormalkan tanpa kolom opsional", () => {
  const result = parseWorkerEdit({ name: "  VPN SG 1 ", host: " vpn1.user.workers.dev ", type: "vpn" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.worker, { name: "VPN SG 1", host: "vpn1.user.workers.dev", type: "vpn" });
  assert.equal("uuid" in result.worker, false);
  assert.equal("vpn_domains" in result.worker, false);
  assert.equal("accountId" in result.worker, false);
});

test("parseWorkerEdit: host dibersihkan dari skema, path, query, dan huruf besar", () => {
  assert.equal(parseWorkerEdit({ name: "a", host: "HTTPS://VPN1.User.Workers.dev/apa?x=1", type: "vpn" }).worker.host, "vpn1.user.workers.dev");
  assert.equal(hostFromInput("  http://a.b.c:8443/x  "), "a.b.c");
});

test("parseWorkerEdit: host tidak sah ditolak dengan alasan", () => {
  for (const host of ["", "   ", "-awal", "akhir-", "a..b", "a b", "a_b.c", "x".repeat(300)]) {
    const result = parseWorkerEdit({ name: "a", host: host, type: "vpn" });
    assert.equal(result.ok, false, `host ${JSON.stringify(host)} seharusnya ditolak`);
    assert.match(result.error, /Domain Worker/);
  }
});

test("parseWorkerEdit: nama kosong ditolak sebelum host diperiksa", () => {
  const result = parseWorkerEdit({ name: "   ", host: "gak-valid", type: "vpn" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nama Worker/);
});

test("parseWorkerEdit: UUID v4 penuh diterima (huruf kecil), versi lain ditolak", () => {
  const ok = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", uuid: "14DF7AEE-0416-45A8-A651-E69DE188DECA" });
  assert.equal(ok.ok, true);
  assert.equal(ok.worker.uuid, "14df7aee-0416-45a8-a651-e69de188deca");

  for (const uuid of ["14df7aee-0416-15a8-a651-e69de188deca", "14df7aee-0416-45a8-c651-e69de188deca", "14df7aee041645a8a651e69de188deca", "bukan-uuid"]) {
    const bad = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", uuid: uuid });
    assert.equal(bad.ok, false, `UUID ${uuid} seharusnya ditolak`);
    assert.match(bad.error, /UUID/);
  }

  const kosong = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", uuid: "  " });
  assert.equal(kosong.ok, true);
  assert.equal("uuid" in kosong.worker, false, "UUID kosong berarti kolomnya dihapus dari state");
});

test("parseWorkerEdit: Account ID harus 32 hex, kalau tidak ditolak", () => {
  const ok = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", accountId: "73570341C33DCC9783D5323433B374D2" });
  assert.equal(ok.ok, true);
  assert.equal(ok.worker.accountId, "73570341c33dcc9783d5323433b374d2");

  for (const accountId of ["73570341c33dcc9783d5323433b374d", "73570341c33dcc9783d5323433b374d2e", "zzzz0341c33dcc9783d5323433b374d2"]) {
    const bad = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", accountId: accountId });
    assert.equal(bad.ok, false, `Account ID ${accountId} seharusnya ditolak`);
    assert.match(bad.error, /Account ID/);
  }
});

test("parseWorkerEdit: daftar VPN domains dipangkas, dibuang yang kosong, dan hanya untuk LB", () => {
  const lb = parseWorkerEdit({
    name: "cfvpn-lb",
    host: "lb.workers.dev",
    type: "load_balancer",
    vpnDomains: " https://VPN1.User.Workers.dev ,, vpn2.user.workers.dev , ",
  });
  assert.deepEqual(lb.worker.vpn_domains, ["vpn1.user.workers.dev", "vpn2.user.workers.dev"]);

  const kosong = parseWorkerEdit({ name: "cfvpn-lb", host: "lb.workers.dev", type: "load_balancer", vpnDomains: " , " });
  assert.equal("vpn_domains" in kosong.worker, false);

  const vpn = parseWorkerEdit({ name: "a", host: "a.b.c", type: "vpn", vpnDomains: "b.c, d.e" });
  assert.equal("vpn_domains" in vpn.worker, false, "worker VPN tidak menyimpan daftar domain LB");
});

test("parseWorkerEdit: jenis tidak dikenal jadi VPN dan masukan kosong tidak melempar", () => {
  assert.equal(parseWorkerEdit({ name: "a", host: "a.b.c", type: "aneh" }).worker.type, "vpn");
  assert.equal(parseWorkerEdit().ok, false);
  assert.equal(parseWorkerEdit(null).ok, false);
});

test("parseSubToken: 32 hex diterima (huruf kecil), bentuk lain ditolak", () => {
  const ok = parseSubToken("  AABBCCDDEEFF00112233445566778899  ");
  assert.deepEqual(ok, { ok: true, token: "aabbccddeeff00112233445566778899" });

  for (const value of ["", "abc", "a".repeat(31), "a".repeat(33), "z".repeat(32), 12345, null]) {
    const bad = parseSubToken(value);
    assert.equal(bad.ok, false, `token ${JSON.stringify(value)} seharusnya ditolak`);
    assert.match(bad.error, /Token langganan/);
  }
});

// --- parseWorkerBatch (tambah banyak worker sekaligus) -----------------------

test("parseWorkerBatch: baris VPN dan LB sah; jenis kosong, lb, dan load-balancer dikenali", () => {
  const result = parseWorkerBatch(
    [
      "VPN SG, vpn1.user.workers.dev, vpn",
      "VPN JP, vpn2.user.workers.dev",
      "LB SG, lb.user.workers.dev, load_balancer, vpn1.user.workers.dev vpn2.user.workers.dev",
      "LB alias, lb2.user.workers.dev, lb, vpn1.user.workers.dev",
      "LB strip, lb3.user.workers.dev, load-balancer",
    ].join("\n"),
    []
  );

  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.workers, [
    { name: "VPN SG", host: "vpn1.user.workers.dev", type: "vpn" },
    { name: "VPN JP", host: "vpn2.user.workers.dev", type: "vpn" },
    { name: "LB SG", host: "lb.user.workers.dev", type: "load_balancer", vpn_domains: ["vpn1.user.workers.dev", "vpn2.user.workers.dev"] },
    { name: "LB alias", host: "lb2.user.workers.dev", type: "load_balancer", vpn_domains: ["vpn1.user.workers.dev"] },
    { name: "LB strip", host: "lb3.user.workers.dev", type: "load_balancer" },
  ]);
});

test("parseWorkerBatch: kolom kosong = tidak diisi, uuid/accountId ditulis huruf kecil", () => {
  const result = parseWorkerBatch("a, a.b.c, vpn, , 14DF7AEE-0416-45A8-A651-E69DE188DECA, 73570341C33DCC9783D5323433B374D2", []);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.workers, [
    { name: "a", host: "a.b.c", type: "vpn", uuid: UUID, accountId: "73570341c33dcc9783d5323433b374d2" },
  ]);

  const lb = parseWorkerBatch("lb, lb.b.c, lb, , , ", []);
  assert.deepEqual(lb.workers, [{ name: "lb", host: "lb.b.c", type: "load_balancer" }]);
});

test("parseWorkerBatch: baris kosong dan baris berawalan # dilewati tanpa dilaporkan", () => {
  const result = parseWorkerBatch("\n   \n# komentar\n   # komentar menjorok\n\n", []);

  assert.deepEqual(result, { workers: [], skipped: [], errors: [] });
});

test("parseWorkerBatch: host yang sudah ada dan duplikat di dalam teks di-skip", () => {
  const result = parseWorkerBatch(
    ["A, vpn1.user.workers.dev, vpn", "B, baru.user.workers.dev, vpn", "B lagi, BARU.user.workers.dev, vpn"].join("\n"),
    ["vpn1.user.workers.dev"]
  );

  assert.deepEqual(result.workers, [{ name: "B", host: "baru.user.workers.dev", type: "vpn" }]);
  assert.deepEqual(result.skipped, [
    { line: 1, reason: "host sudah terdaftar" },
    { line: 3, reason: "host sudah terdaftar" },
  ]);
  assert.deepEqual(result.errors, []);
});

test("parseWorkerBatch: nama kosong memakai host tanpa .workers.dev, bentrok nama di-skip", () => {
  const result = parseWorkerBatch(
    [", contoh.workers.dev, vpn", ", baru.workers.dev, vpn", ", sudah.workers.dev, vpn", ", aman.workers.dev, vpn"].join("\n"),
    [{ host: "lama.workers.dev", name: "baru" }, { host: "x.workers.dev", name: "sudah" }]
  );

  assert.deepEqual(result.workers.map((worker) => worker.name), ["contoh", "aman"]);
  assert.equal(result.workers[0].host, "contoh.workers.dev");
  assert.equal(parseWorkerBatch(", contoh.example.com", []).workers[0].name, "contoh.example.com", "host tanpa akhiran .workers.dev dipakai apa adanya");
  assert.deepEqual(result.skipped, [
    { line: 2, reason: "nama sudah dipakai" },
    { line: 3, reason: "nama sudah dipakai" },
  ]);
});

test("parseWorkerBatch: baris tidak sah masuk errors dengan nomor baris dan alasan singkat", () => {
  const result = parseWorkerBatch(
    ["# komentar", "host tidak sah, host..salah, vpn", "uuid salah, a.b.c, vpn, , bukan-uuid", "account salah, d.e.f, vpn, , , bukan-account", ", , vpn"].join("\n"),
    []
  );

  assert.deepEqual(result.workers, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errors, [
    { line: 2, reason: "host tidak sah" },
    { line: 3, reason: "UUID bukan v4" },
    { line: 4, reason: "Account ID bukan 32 hex" },
    { line: 5, reason: "host tidak sah" },
  ]);
});

test("parseWorkerBatch: baris campur (sah + rusak + skip) menghasilkan ketiganya", () => {
  const result = parseWorkerBatch(
    ["sah, satu.user.workers.dev, vpn", "rusak, host..salah, vpn", "duplikat, satu.user.workers.dev, vpn", "sah2, dua.workers.dev, lb, satu.user.workers.dev"].join("\n"),
    []
  );

  assert.deepEqual(result.workers.map((worker) => worker.name), ["sah", "sah2"]);
  assert.deepEqual(result.workers[1].vpn_domains, ["satu.user.workers.dev"]);
  assert.deepEqual(result.skipped, [{ line: 3, reason: "host sudah terdaftar" }]);
  assert.deepEqual(result.errors, [{ line: 2, reason: "host tidak sah" }]);
});

test("parseWorkerBatch: masukan kosong/bukan teks dan baris CRLF tidak melempar", () => {
  assert.deepEqual(parseWorkerBatch(undefined, undefined), { workers: [], skipped: [], errors: [] });
  assert.deepEqual(parseWorkerBatch("", []), { workers: [], skipped: [], errors: [] });

  const crlf = parseWorkerBatch("a, a.b.c, vpn\r\nrusak, host..salah, vpn\r\n", []);
  assert.deepEqual(crlf.workers.map((worker) => worker.host), ["a.b.c"]);
  assert.deepEqual(crlf.errors, [{ line: 2, reason: "host tidak sah" }]);
});
