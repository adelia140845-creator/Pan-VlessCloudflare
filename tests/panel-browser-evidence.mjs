// Bukti browser untuk empat fitur panel (Playwright, Chromium headless):
//   A. admin.html   — Reset sandi + Buka kunci lewat RPC admin_action (sukses & migrasi belum ada)
//   B. workers.html — Edit data worker (tersimpan, dan validasi menolak UUID/host/Account ID salah)
//      + "Tambah batch" (3 baris: 2 sah + 1 rusak -> 2 worker masuk, pesan menyebut baris rusaknya;
//      baris hanya-domain -> nama otomatis akun 1, akun 2, ...)
//   C. workers.html + generator.html — fitur kuota sudah dibuang (tanpa panel/badge kuota, kunci lama
//      dibersihkan) sementara blok health/uptime (Cek semua) tetap jalan
//   D. workers.html — "Tetapkan token" LB (32 hex) menulis state tanpa memanggil Cloudflare
//   F. proxy.html   — tabel ringkasan per negara, tombol urut, tombol copy per baris
//   G. generator.html — dropdown mode (satu proxy / rotasi /ALL / rotasi negara): path di #resultText
//
// Semua jaringan dipalsukan: berkas frontend disajikan server lokal Node, impor CDN
// @supabase/supabase-js dijawab stub oleh satu route handler.
// Tidak ada Supabase/Cloudflare sungguhan yang disentuh.
//
// Jalankan manual: node tests/panel-browser-evidence.mjs
// TIDAK ikut `npm test` (pola tests/*.test.mjs) karena butuh browser; CI tidak memasang playwright.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const FRONTEND = fileURLToPath(new URL("../frontend/", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain" };

// Stub @supabase/supabase-js: cukup untuk apa yang dipakai app.js (rpc, from().select/eq/gt/in/
// order/insert/update/upsert/delete/maybeSingle). Semua keputusan ada di window.__supaRoute.
const SUPA_STUB = `
export function createClient() {
  function send(req) { return Promise.resolve(window.__supaRoute(req)); }
  function builder(table) {
    var req = { table: table, filters: [], op: "select" };
    var api = {
      select: function (columns, options) { req.op = "select"; req.options = options || {}; return api; },
      eq: function (column, value) { req.filters.push([column, value]); return api; },
      gt: function (column, value) { req.filters.push([column, value, "gt"]); return api; },
      in: function (column, values) { req.filters.push([column, values, "in"]); return api; },
      order: function (column, options) { req.order = [column, options]; return api; },
      limit: function (n) { req.limit = n; return api; },
      insert: function (values) { req.op = "insert"; req.values = values; return api; },
      update: function (values) { req.op = "update"; req.values = values; return api; },
      upsert: function (values) { req.op = "upsert"; req.values = values; return api; },
      delete: function () { req.op = "delete"; return api; },
      maybeSingle: function () { req.single = "maybe"; return api; },
      single: function () { req.single = "one"; return api; },
      then: function (resolve, reject) { send(req).then(resolve, reject); }
    };
    return api;
  }
  return {
    rpc: function (name, args) { return send({ op: "rpc", name: name, args: args }); },
    from: function (table) { return builder(table); },
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    }
  };
}
export default { createClient };
`;

// applyConfig dipasang sebagai init script: sesi panel, state, router Supabase palsu, dan — untuk
// skenario C — sisa simpanan fitur kuota lama yang harus dibersihkan panel.
function applyConfig(config) {
  window.__config = config;
  try {
    localStorage.setItem("CFVPN-vpn-panel-session", JSON.stringify(config.session));
    if (config.legacyQuota) {
      localStorage.setItem("workerDailyQuota", "100000");
      localStorage.setItem("accountQuotaThreshold", "90");
      localStorage.setItem("accountQuotaGate", JSON.stringify({ v: 1, day: new Date().toISOString().slice(0, 10), accounts: { "acc-lama": { used: 1000 } } }));
      localStorage.setItem("accountQuotaGate:acc-lama", JSON.stringify({ v: 1, accountId: "acc-lama", account: { used: 1000 } }));
    }
  } catch {
    // Init script juga jalan di about:blank (asal opaque): localStorage-nya belum bisa dibaca dan
    // itu tidak penting — dokumen panel yang sesungguhnya dapat origin http://127.0.0.1.
  }
  window.__rpcLog = [];
  window.__savedStates = [];
  window.__supaRoute = function (req) {
    var cfg = window.__config;
    if (req.op === "rpc") {
      window.__rpcLog.push({ name: req.name, args: req.args });
      if (req.name === "whoami") return { data: cfg.role, error: null };
      if (req.name === "get_state") return { data: cfg.state, error: null };
      if (req.name === "save_state") { window.__savedStates.push(req.args.p_state); return { data: true, error: null }; }
      if (req.name === "admin_action") {
        if (cfg.adminAction === "unknown") return { data: null, error: { code: "22023", message: "Aksi tidak dikenal: " + req.args.p_action } };
        if (cfg.adminAction === "missing") return { data: null, error: { code: "PGRST202", message: "Could not find the function public.admin_action" } };
        return { data: true, error: null };
      }
      return { data: null, error: { code: "PGRST202", message: "Could not find the function " + req.name } };
    }
    if (req.table === "users_custom" && req.op === "select") {
      var users = cfg.users || [];
      for (var i = 0; i < req.filters.length; i += 1) {
        var filter = req.filters[i];
        if (filter[0] === "role") users = users.filter(function (u) { return u.role === filter[1]; });
      }
      if (req.options && req.options.count) return { count: users.length, data: null, error: null };
      return { data: users, error: null };
    }
    if (req.table === "proxy_pool" && req.op === "select") {
      if (req.options && req.options.count) return { count: (cfg.proxies || []).length, data: null, error: null };
      return { data: cfg.proxies || [], error: null };
    }
    return { data: null, error: null };
  };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const file = join(FRONTEND, path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const pageNotes = [];

// Satu konteks per skenario: init script (sesi + state + router) tidak bisa dicabut, sedangkan
// tiap skenario butuh state berbeda. Server worker (health) dipalsukan;
// sisa host luar di-abort supaya tidak ada permintaan sungguhan yang keluar.
async function withPanel(config, run) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(applyConfig, config);
  const net = { health: [] };
  const dialogs = [];
  let dialogAnswer = "";
  context.on("page", (page) => {
    page.on("dialog", (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      dialog.accept(dialog.type() === "prompt" ? dialogAnswer : undefined).catch(() => {});
    });
    page.on("pageerror", (error) => pageNotes.push(`pageerror: ${error.message}`));
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("https://cdn.jsdelivr.net/")) {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: SUPA_STUB });
    }
    if (url.includes("/health")) {
      net.health.push(url);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, type: "vpn", version: "2026-11-15b" }) });
    }
    if (url.startsWith(BASE)) return route.continue();
    return route.abort();
  });

  const page = await context.newPage();
  const helpers = {
    net: net,
    dialogs: dialogs,
    setDialogAnswer: (value) => { dialogAnswer = value; },
    lastDialog: () => dialogs[dialogs.length - 1],
    // Dialog adalah kejadian asinkron di sisi Playwright: tunggu sampai jumlahnya bertambah.
    waitForDialog: async () => {
      const before = dialogs.length;
      for (let i = 0; i < 100 && dialogs.length === before; i += 1) await page.waitForTimeout(20);
      return dialogs[dialogs.length - 1];
    },
  };
  try {
    await run(page, helpers);
  } catch (error) {
    // Timeout/pengecualian di satu skenario tidak menghentikan skenario lain: kegagalannya
    // dilaporkan sebagai pemeriksaan yang gagal supaya sisa bukti tetap terkumpul.
    check("skenario selesai tanpa error", false, (error && error.message) || String(error));
  } finally {
    await context.close();
  }
}

const ADMIN_STATE = {
  generatedCount: 0,
  workers: [{ id: "w1", name: "cfvpn-vpn-sg", host: "vpn1.user.workers.dev", type: "vpn", active: true }],
};
const USERS = [{ username: "bos", role: "admin" }, { username: "budi", role: "user" }];
const SESSION = { username: "bos", role: "admin", hash: "hash-sesi-panel" };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// --------------------------------------------------------------- A. admin
await withPanel({ session: SESSION, role: "admin", users: USERS, state: ADMIN_STATE, adminAction: "ok" }, async (page, h) => {
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector("[data-reset-password]");

  h.setDialogAnswer("sandiBaru123");
  await page.click('[data-reset-password="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("Sandi budi"));
  const calls = await page.evaluate(() => window.__rpcLog.filter((c) => c.name === "admin_action"));
  const reset = calls[calls.length - 1];
  check("A1 reset sandi memanggil admin_action set_password", Boolean(reset) && reset.args.p_action === "set_password" && reset.args.p_target === "budi", JSON.stringify(reset && reset.args));
  check("A2 sandi dikirim sebagai SHA-256 hex 64 karakter (bukan sandi mentah)", Boolean(reset) && reset.args.p_password === sha256("sandiBaru123") && !JSON.stringify(reset.args).includes("sandiBaru123"));
  check("A3 pesan sukses ditampilkan apa adanya", (await page.evaluate(() => document.getElementById("userMessage").textContent)) === "Sandi budi diperbarui.");

  await page.click('[data-unlock-user="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("Kunci login budi"));
  const unlock = (await page.evaluate(() => window.__rpcLog.filter((c) => c.name === "admin_action"))).pop();
  check("A4 buka kunci memanggil admin_action unlock", unlock.args.p_action === "unlock" && unlock.args.p_target === "budi", JSON.stringify(unlock.args));

  const before = await page.evaluate(() => window.__rpcLog.filter((c) => c.name === "admin_action").length);
  h.setDialogAnswer("pdk");
  await page.click('[data-reset-password="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("minimal 6"));
  const after = await page.evaluate(() => window.__rpcLog.filter((c) => c.name === "admin_action").length);
  check("A5 sandi < 6 karakter ditolak sebelum RPC dipanggil", before === after, `panggilan ${before} -> ${after}`);
});

// A. migrasi admin-action belum dijalankan: errcode 22023 "Aksi tidak dikenal"
await withPanel({ session: SESSION, role: "admin", users: USERS, state: ADMIN_STATE, adminAction: "unknown" }, async (page, h) => {
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector("[data-reset-password]");
  h.setDialogAnswer("sandiBaru123");
  await page.click('[data-reset-password="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("Migrasi"));
  const message = await page.evaluate(() => document.getElementById("userMessage").textContent);
  check("A6 aksi tidak dikenal -> pesan migrasi admin-action", /Migrasi admin-action belum dijalankan/.test(message), message);
  check("A7 sesi TIDAK dihapus saat migrasi belum ada", await page.evaluate(() => Boolean(localStorage.getItem("CFVPN-vpn-panel-session"))));

  await page.click('[data-unlock-user="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("Migrasi"));
  check("A8 buka kunci tanpa migrasi memberi pesan migrasi yang sama", /Migrasi admin-action belum dijalankan/.test(await page.evaluate(() => document.getElementById("userMessage").textContent)));
});

// A. RPC-nya belum ada sama sekali (PGRST202)
await withPanel({ session: SESSION, role: "admin", users: USERS, state: ADMIN_STATE, adminAction: "missing" }, async (page, h) => {
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector("[data-reset-password]");
  h.setDialogAnswer("sandiBaru123");
  await page.click('[data-reset-password="budi"]');
  await page.waitForFunction(() => document.getElementById("userMessage").textContent.includes("Migrasi"));
  check("A9 PGRST202 -> pesan migrasi yang sama", /Migrasi admin-action belum dijalankan/.test(await page.evaluate(() => document.getElementById("userMessage").textContent)));
});

// --------------------------------------- B. edit worker + validasi isiannya
const EDIT_STATE = {
  generatedCount: 0,
  workers: [
    { id: "w1", name: "cfvpn-vpn-sg", host: "vpn1.user.workers.dev", type: "vpn", active: true, uuid: "14df7aee-0416-45a8-a651-e69de188deca" },
    { id: "w2", name: "cfvpn-lb", host: "lb.user.workers.dev", type: "load_balancer", active: true, vpn_domains: ["vpn1.user.workers.dev"] },
  ],
};

await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE }, async (page, h) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector('[data-edit-worker="w1"]');

  await page.click('[data-edit-worker="w1"]');
  const prefilled = await page.evaluate(() => ({
    name: document.getElementById("workerName").value,
    host: document.getElementById("workerHost").value,
    type: document.getElementById("workerType").value,
    uuid: document.getElementById("workerUuid").value,
    accountId: document.getElementById("workerAccountId").value,
    submit: document.querySelector("#addWorkerForm button[type=submit]").textContent,
  }));
  check("B1 tombol Edit mengisi form dari state", prefilled.name === "cfvpn-vpn-sg" && prefilled.uuid === "14df7aee-0416-45a8-a651-e69de188deca" && prefilled.submit === "Update Worker", JSON.stringify(prefilled));

  await page.fill("#workerName", "VPN SG Baru");
  await page.fill("#workerUuid", "AABBCCDD-EEFF-4011-8222-334455667788");
  await page.fill("#workerAccountId", "73570341C33DCC9783D5323433B374D2");
  await page.click("#addWorkerForm button[type=submit]");
  await page.waitForFunction(() => document.getElementById("addWorkerForm").hidden);
  const saved = await page.evaluate(() => window.__savedStates[window.__savedStates.length - 1]);
  const edited = saved && saved.workers.find((w) => w.id === "w1");
  check(
    "B2 edit tersimpan ke state lewat save_state",
    Boolean(edited) && edited.name === "VPN SG Baru" && edited.uuid === "aabbccdd-eeff-4011-8222-334455667788" && edited.accountId === "73570341c33dcc9783d5323433b374d2",
    JSON.stringify(edited)
  );
  const savesAfterEdit = await page.evaluate(() => window.__savedStates.length);

  // UUID bukan v4 -> alert, state tidak bertambah
  await page.click('[data-edit-worker="w1"]');
  await page.fill("#workerUuid", "bukan-uuid");
  const uuidDialog = h.waitForDialog();
  await page.click("#addWorkerForm button[type=submit]");
  const uuidAlert = await uuidDialog;
  check("B3 UUID bukan v4 ditolak dengan alasan", uuidAlert.type === "alert" && /UUID harus UUID v4/.test(uuidAlert.message), uuidAlert.message);
  check("B4 penolakan tidak menyimpan state", (await page.evaluate(() => window.__savedStates.length)) === savesAfterEdit);

  // Host tidak sah
  await page.fill("#workerUuid", "");
  await page.fill("#workerHost", "host..salah");
  const hostDialog = h.waitForDialog();
  await page.click("#addWorkerForm button[type=submit]");
  const hostAlert = await hostDialog;
  check("B5 host tidak sah ditolak", /Domain Worker tidak valid/.test(hostAlert.message), hostAlert.message);

  // Account ID tidak sah
  await page.fill("#workerHost", "vpn1.user.workers.dev");
  await page.fill("#workerAccountId", "bukan-account-id");
  const accountDialog = h.waitForDialog();
  await page.click("#addWorkerForm button[type=submit]");
  const accountAlert = await accountDialog;
  check("B6 Account ID tidak sah ditolak", /Account ID Cloudflare harus 32 karakter hex/.test(accountAlert.message), accountAlert.message);
  check("B7 tiga penolakan tetap tidak menyimpan state", (await page.evaluate(() => window.__savedStates.length)) === savesAfterEdit);

  // Edit LB: daftar domain dinormalkan (pangkas, buang kosong, buang skema)
  await page.fill("#workerAccountId", "");
  await page.click('[data-edit-worker="w2"]');
  await page.fill("#workerVpnDomains", " HTTPS://VPN1.User.Workers.dev , ,vpn2.user.workers.dev ");
  await page.click("#addWorkerForm button[type=submit]");
  await page.waitForFunction(() => document.getElementById("addWorkerForm").hidden);
  const afterLb = await page.evaluate(() => window.__savedStates[window.__savedStates.length - 1]);
  const lb = afterLb && afterLb.workers.find((w) => w.id === "w2");
  check("B8 edit LB menormalkan daftar VPN domains", Boolean(lb) && JSON.stringify(lb.vpn_domains) === JSON.stringify(["vpn1.user.workers.dev", "vpn2.user.workers.dev"]), JSON.stringify(lb && lb.vpn_domains));
});

// B batch. "Tambah batch": 3 baris (2 sah + 1 rusak) -> hanya 2 worker masuk, panel Edit tetap jalan
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE }, async (page) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector('[data-edit-worker="w1"]');

  check("B9 panel batch tersembunyi sebelum tombolnya ditekan", await page.evaluate(() => document.getElementById("batchPanel").hidden));
  await page.click("#showBatchWorkers");
  check("B10 tombol Tambah batch membuka panel", await page.evaluate(() => !document.getElementById("batchPanel").hidden));

  await page.fill(
    "#batchWorkersInput",
    [
      "VPN JP, vpn-jp.user.workers.dev, vpn, , 14df7aee-0416-45a8-a651-e69de188deca, 73570341c33dcc9783d5323433b374d2",
      "LB SG, lb-sg.user.workers.dev, lb, vpn-jp.user.workers.dev vpn1.user.workers.dev",
      "VPN Rusak, host..salah, vpn",
    ].join("\n")
  );
  await page.click("#batchAddWorkers");
  await page.waitForFunction(() => document.getElementById("batchMessage").textContent.includes("ditambahkan"));

  const batch = await page.evaluate(() => ({
    message: document.getElementById("batchMessage").textContent,
    textarea: document.getElementById("batchWorkersInput").value,
    saved: window.__savedStates[window.__savedStates.length - 1],
  }));
  const addedVpn = batch.saved.workers.find((w) => w.name === "VPN JP");
  const addedLb = batch.saved.workers.find((w) => w.name === "LB SG");
  check(
    "B11 hanya 2 worker sah yang masuk state (baris rusak tidak ikut)",
    batch.saved.workers.length === 4 && !batch.saved.workers.some((w) => w.name === "VPN Rusak"),
    JSON.stringify(batch.saved.workers.map((w) => w.name))
  );
  check(
    "B12 worker batch tersimpan seperti jalur tambah manual (id baru + aktif + opsional)",
    Boolean(addedVpn) && Boolean(addedLb)
      && typeof addedVpn.id === "string" && addedVpn.id.length > 0 && addedVpn.active === true && addedVpn.source === "manual"
      && addedVpn.uuid === "14df7aee-0416-45a8-a651-e69de188deca" && addedVpn.accountId === "73570341c33dcc9783d5323433b374d2"
      && addedLb.type === "load_balancer" && addedLb.active === true
      && JSON.stringify(addedLb.vpn_domains) === JSON.stringify(["vpn-jp.user.workers.dev", "vpn1.user.workers.dev"])
      && !("uuid" in addedLb),
    JSON.stringify([addedVpn, addedLb])
  );
  check(
    "B13 pesan menyebut baris rusaknya, bukan mengklaim 3 worker",
    batch.message.startsWith("2 worker ditambahkan") && /error baris 3: host tidak sah/.test(batch.message),
    batch.message
  );
  check("B14 textarea dikosongkan setelah berhasil", batch.textarea === "", JSON.stringify(batch.textarea));
  check("B15 kartu worker baru tampil di daftar", await page.evaluate(() => document.getElementById("workerList").textContent.includes("LB SG") && document.getElementById("workerList").textContent.includes("VPN JP")));

  // Panel Edit worker lama tidak rusak oleh panel batch: form yang sama masih bisa dibuka & diisi.
  await page.click('[data-edit-worker="w2"]');
  const editPrefill = await page.evaluate(() => ({
    name: document.getElementById("workerName").value,
    host: document.getElementById("workerHost").value,
    submit: document.querySelector("#addWorkerForm button[type=submit]").textContent,
  }));
  check(
    "B16 panel Edit worker lama tetap berfungsi setelah tambah batch",
    editPrefill.name === "cfvpn-lb" && editPrefill.host === "lb.user.workers.dev" && editPrefill.submit === "Update Worker",
    JSON.stringify(editPrefill)
  );
});

// B batch. Semua baris gagal/dilewati -> state tidak disentuh (tanpa save_state sama sekali)
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE }, async (page) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector('[data-edit-worker="w1"]');
  await page.click("#showBatchWorkers");
  await page.fill("#batchWorkersInput", ["Broken, host..salah, vpn", "Hm, vpn1.user.workers.dev, vpn"].join("\n"));
  await page.click("#batchAddWorkers");
  await page.waitForFunction(() => document.getElementById("batchMessage").textContent.includes("0 worker ditambahkan"));

  const after = await page.evaluate(() => ({
    message: document.getElementById("batchMessage").textContent,
    saves: window.__savedStates.length,
    textarea: document.getElementById("batchWorkersInput").value,
    cards: document.querySelectorAll("#workerList .worker-card").length,
  }));
  check("B17 semua baris gagal/dilewati -> tidak ada save_state dan kartu tetap 2", after.saves === 0 && after.cards === 2, JSON.stringify(after));
  check(
    "B18 pesan jujur: 0 ditambahkan, 1 dilewati, error baris 1",
    after.message.startsWith("0 worker ditambahkan") && after.message.includes("1 dilewati (host sudah terdaftar)") && after.message.includes("error baris 1: host tidak sah"),
    after.message
  );
  check("B19 teks batch tetap ada supaya bisa diperbaiki", after.textarea.includes("host..salah"));
});

// B batch. Baris hanya-domain: nama otomatis akun 1, akun 2 (dan tempelan kedua melanjutkan)
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE }, async (page) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector('[data-edit-worker="w1"]');
  await page.click("#showBatchWorkers");
  await page.fill("#batchWorkersInput", ["vpn-akun1.user.workers.dev", "vpn-akun2.user.workers.dev"].join("\n"));
  await page.click("#batchAddWorkers");
  await page.waitForFunction(() => window.__savedStates.length === 1);

  const first = await page.evaluate(() => ({
    message: document.getElementById("batchMessage").textContent,
    added: window.__savedStates[0].workers.filter((w) => w.name.startsWith("akun ")).map((w) => ({ name: w.name, host: w.host, type: w.type, active: w.active, source: w.source })),
    titles: [...document.querySelectorAll("#workerList .worker-title")].map((el) => el.textContent),
  }));
  check(
    "B20 dua baris hanya-domain -> dua worker VPN bernama akun 1 dan akun 2",
    JSON.stringify(first.added) === JSON.stringify([
      { name: "akun 1", host: "vpn-akun1.user.workers.dev", type: "vpn", active: true, source: "manual" },
      { name: "akun 2", host: "vpn-akun2.user.workers.dev", type: "vpn", active: true, source: "manual" },
    ]),
    JSON.stringify(first.added)
  );
  check("B21 kartu akun 1 dan akun 2 tampil di daftar", first.titles.includes("akun 1") && first.titles.includes("akun 2"), JSON.stringify(first.titles));
  check("B22 pesan mengaku 2 worker ditambahkan tanpa error", first.message === "2 worker ditambahkan", first.message);

  await page.fill("#batchWorkersInput", "vpn-akun3.user.workers.dev");
  await page.click("#batchAddWorkers");
  await page.waitForFunction(() => window.__savedStates.length === 2);
  const names = await page.evaluate(() => window.__savedStates[1].workers.map((w) => w.name));
  check("B23 tempelan berikutnya melanjutkan penomoran -> akun 3", names[names.length - 1] === "akun 3" && names.length === 5, JSON.stringify(names));
});

// ------------------------- C. fitur kuota dibuang, health tetap jalan
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE, legacyQuota: true }, async (page, h) => {
  await page.goto(`${BASE}/workers.html`);
  // Kontainer health kosong (belum ada probe) tidak "visible" bagi Playwright — tunggu attached.
  await page.waitForSelector('[data-health="w1"]', { state: "attached" });

  const leftovers = await page.evaluate(() => ({
    panel: Boolean(document.getElementById("quotaPanel")),
    table: Boolean(document.getElementById("quotaTable")),
    daily: Boolean(document.getElementById("workerDailyQuota")),
    threshold: Boolean(document.getElementById("accountQuotaThreshold")),
    reload: Boolean(document.getElementById("reloadQuota")),
    fetched: Boolean(document.getElementById("quotaFetchedAt")),
    gate: Boolean(document.getElementById("quotaGateStatus")),
  }));
  check("C1 panel kuota tidak lagi ada di halaman Workers", !Object.values(leftovers).some(Boolean), JSON.stringify(leftovers));

  const card = await page.evaluate(() => document.querySelector("#workerList").textContent.toLowerCase());
  check("C2 kartu worker tidak lagi memuat teks kuota", !card.includes("kuota"), card.slice(0, 120));

  const keys = await page.evaluate(() => ["workerDailyQuota", "accountQuotaThreshold", "accountQuotaGate", "accountQuotaGate:acc-lama"].filter((k) => localStorage.getItem(k) !== null));
  check("C3 kunci kuota lama dibersihkan saat halaman Workers dibuka", keys.length === 0, JSON.stringify(keys));

  // Memuat halaman TIDAK boleh memanggil /health: setiap probe memakai jatah request worker yang sama
  // dengan tunnel klien, itu alasan fitur pemeriksaan otomatis dibuang.
  const autoHealth = await page.evaluate(() => (document.querySelector('[data-health="w1"]')?.textContent || "").trim());
  check(
    "C4 halaman Workers tidak memanggil /health otomatis dan kartu tidak menampilkan uptime",
    autoHealth === "" && h.net.health.length === 0,
    JSON.stringify({ teks: autoHealth.slice(0, 60), health: h.net.health.length })
  );

  // Baru setelah diminta manual, hasilnya muncul (uptime + versi worker).
  await page.click("#checkAllHealth");
  await page.waitForFunction(() => /uptime .*dari \d+ cek terakhir/.test(document.querySelector('[data-health="w1"]').textContent), { timeout: 15000 });
  const health = await page.evaluate(() => document.querySelector('[data-health="w1"]').textContent);
  check(
    "C4b pemeriksaan manual menampilkan uptime + versi",
    /uptime .*dari \d+ cek terakhir/.test(health) && h.net.health.length > 0,
    JSON.stringify({ teks: health.replace(/\s+/g, " ").slice(0, 120), health: h.net.health.length })
  );
});

// C. Generator tidak lagi menyebut / menyaring kuota
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE, legacyQuota: true }, async (page) => {
  await page.goto(`${BASE}/generator.html`);
  await page.waitForFunction(() => Boolean(document.querySelector("#workerSelect option[value='w1']")));
  check("C7 catatan gate kuota hilang dari Generator", await page.evaluate(() => !document.getElementById("quotaGateNote")));
  check("C8 Generator tidak lagi menyebut kuota sama sekali", await page.evaluate(() => !/kuota/i.test(document.body.textContent)));
  check("C9 semua worker aktif tetap ditawarkan (tanpa penyaringan kuota)", await page.evaluate(() => [...document.querySelectorAll("#workerSelect option")].map((o) => o.value).includes("w1")));
});

// ----------------------------------------------------------- D. token LB
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE }, async (page, h) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector('[data-set-token="w2"]');
  check("D1 badge peringatan tampil kalau LB belum punya token", await page.evaluate(() => document.querySelector('[data-set-token="w2"]').closest(".lb-details").textContent.includes("token langganan belum ada")));

  h.setDialogAnswer("AABBCCDDEEFF00112233445566778899");
  await page.click('[data-set-token="w2"]');
  await page.waitForFunction(() => document.getElementById("workersMessage").textContent.includes("disimpan"));
  const saved = await page.evaluate(() => window.__savedStates[window.__savedStates.length - 1]);
  const lb = saved && saved.workers.find((w) => w.id === "w2");
  check("D2 token 32 hex (huruf kecil) ditulis ke state.workers[].sub_token", Boolean(lb) && lb.sub_token === "aabbccddeeff00112233445566778899", JSON.stringify(lb && lb.sub_token));
  check("D3 URL langganan kartu memuat token setelah disimpan", await page.evaluate(() => document.querySelector(".sub-url").textContent.includes("t=aabbccddeeff00112233445566778899")));
  check("D4 badge peringatan hilang setelah token disimpan", await page.evaluate(() => !document.querySelector('[data-set-token="w2"]').closest(".lb-details").textContent.includes("token langganan belum ada")));

  h.setDialogAnswer("bukan-token");
  await page.click('[data-set-token="w2"]');
  await page.waitForFunction(() => document.getElementById("workersMessage").textContent.includes("Token langganan harus"));
  const after = await page.evaluate(() => window.__savedStates[window.__savedStates.length - 1].workers.find((w) => w.id === "w2").sub_token);
  check("D5 token tidak sah ditolak + nilai lama tetap utuh", after === "aabbccddeeff00112233445566778899", after);
});

// --------------------------------------------------- F. proxy ringkasan negara
const now = Date.now();
const hoursAgo = (hours) => new Date(now - hours * 3600 * 1000).toISOString();
const PROXIES = [
  { ip: "1.1.1.1", port: 443, country: "SG", org: "ISP A", is_active: true, last_checked: hoursAgo(1), ping: 90, tunnel_ok: true, tunnel_ms: 120, tls_ok: true, tunnel_host_ok: true, tunnel_host_ms: 110 },
  { ip: "1.1.1.2", port: 443, country: "SG", org: "ISP A", is_active: true, last_checked: hoursAgo(2), ping: 40, tunnel_ok: null, tunnel_ms: 0, tls_ok: false, tunnel_host_ok: false, tunnel_host_ms: 0 },
  { ip: "1.1.1.3", port: 80, country: "SG", org: "ISP B", is_active: false, last_checked: hoursAgo(3), ping: 0, tunnel_ok: false, tunnel_ms: 0, tls_ok: true, tunnel_host_ok: true, tunnel_host_ms: 100 },
  { ip: "2.2.2.1", port: 443, country: "JP", org: "ISP C", is_active: true, last_checked: hoursAgo(30), ping: 200, tunnel_ok: null, tunnel_ms: 0, tls_ok: true, tunnel_host_ok: false, tunnel_host_ms: 0 },
  { ip: "2.2.2.2", port: 443, country: "US", org: "ISP D", is_active: false, last_checked: hoursAgo(4), ping: 0, tunnel_ok: false, tunnel_ms: 0, tls_ok: false, tunnel_host_ok: false, tunnel_host_ms: 0 },
];

await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE, proxies: PROXIES }, async (page) => {
  await page.goto(`${BASE}/proxy.html`);
  await page.waitForSelector("#proxyCountrySummary table");
  const summary = await page.evaluate(() => [...document.querySelectorAll("#proxyCountrySummary tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  const sg = summary.find((row) => row[0].includes("SG"));
  check("F1 ringkasan per negara: total/segar/terbukti edge/mati di edge", JSON.stringify(sg) === JSON.stringify(["🇸🇬 SG", "3", "3", "1", "1"]), JSON.stringify(summary));
  check("F2 negara tanpa baris segar melaporkan 0 (bukan mengarang)", JSON.stringify(summary.find((row) => row[0].includes("JP"))) === JSON.stringify(["🇯🇵 JP", "1", "0", "0", "0"]));

  const copyButtons = await page.evaluate(() => [...document.querySelectorAll("[data-copy-proxy]")].map((b) => b.dataset.copyProxy));
  check("F3 tombol copy ip:port tersedia per baris", copyButtons.length === 3 && copyButtons.includes("1.1.1.1:443"), JSON.stringify(copyButtons));

  check("F4 tombol urut negara/ping/terbaru ada", await page.evaluate(() => ["proxySortCountryBtn", "proxySortPingBtn", "proxySortRecentBtn"].every((id) => Boolean(document.getElementById(id)))));

  await page.click("#proxySortPingBtn");
  const byPing = await page.evaluate(() => [...document.querySelectorAll("#proxyTableBody tr td:first-child code")].map((c) => c.textContent));
  check("F5 urut ping (tercepat dulu, ping 0 di belakang)", JSON.stringify(byPing) === JSON.stringify(["1.1.1.2:443", "1.1.1.1:443", "2.2.2.1:443"]), JSON.stringify(byPing));

  await page.click("#proxySortCountryBtn");
  const byCountry = await page.evaluate(() => [...document.querySelectorAll("#proxyTableBody tr td:first-child code")].map((c) => c.textContent));
  check("F6 urut negara (abjad: JP dulu, lalu SG menurut IP)", JSON.stringify(byCountry) === JSON.stringify(["2.2.2.1:443", "1.1.1.1:443", "1.1.1.2:443"]), JSON.stringify(byCountry));

  await page.click("#proxySortRecentBtn");
  const byRecent = await page.evaluate(() => [...document.querySelectorAll("#proxyTableBody tr td:first-child code")].map((c) => c.textContent));
  check("F7 urut terbaru (last_checked terbaru dulu)", JSON.stringify(byRecent) === JSON.stringify(["1.1.1.1:443", "1.1.1.2:443", "2.2.2.1:443"]), JSON.stringify(byRecent));
});

// ---------------------------------- G. Generator: dropdown mode (bukan ceklist rotasi)
// Bukti: tiap mode menulis path yang benar di #resultText, mode "negara terpilih" tanpa negara
// ditolak dengan pesan (tanpa config), dan filter negara tidak menyaring di mode /ALL.
await withPanel({ session: SESSION, role: "admin", state: EDIT_STATE, proxies: PROXIES }, async (page) => {
  await page.goto(`${BASE}/generator.html`);
  await page.waitForFunction(() => Boolean(document.querySelector("#workerSelect option[value='w1']")));
  await page.waitForFunction(() => document.getElementById("formMessage").textContent.includes("proxy aktif tersedia"));
  await page.selectOption("#workerSelect", "w1");

  check("G1 ceklist rotasi diganti dropdown mode", await page.evaluate(() => !document.getElementById("rotateMode") && document.getElementById("rotateSelect")?.value === "off"));
  check(
    "G2 dropdown punya tiga mode: off/all/country",
    (await page.evaluate(() => [...document.querySelectorAll("#rotateSelect option")].map((o) => o.value).join(","))) === "off,all,country"
  );
  check(
    "G3 ada penjelasan singkat (<= 60 karakter) di bawah label mode",
    await page.evaluate(() => {
      const hint = document.querySelector("#rotateSelect").parentElement.querySelector("small");
      return Boolean(hint) && hint.textContent.trim().length <= 60;
    })
  );

  const result = () => page.evaluate(() => document.getElementById("resultText").value);
  const message = () => page.evaluate(() => document.getElementById("formMessage").textContent);
  const preview = () => page.evaluate(() => document.getElementById("urlPreview").textContent);
  const pathOf = (text) => (String(text).match(/path=%2F[^&]*/) || [""])[0];

  // off: daftar proxy dipakai apa adanya (filter negara kosong = semua), path = proxy terpilih
  await page.click("#generateButton");
  await page.waitForFunction(() => document.getElementById("resultText").value.includes("vless://"));
  const off = await result();
  check("G4 mode satu proxy -> path /<ip>-<port>", /path=%2F\d+\.\d+\.\d+\.\d+-\d+/.test(off), pathOf(off));

  // all: /ALL walau filter negara terisi (worker yang memilih proxy)
  await page.selectOption("#rotateSelect", "all");
  await page.selectOption("#countrySelect", "ID");
  const allPreview = await preview();
  check("G5 pratinjau menyebut rotasi /ALL + filter negara tidak dipakai", /rotasi · \/ALL/.test(allPreview) && /filter negara tidak dipakai/.test(allPreview), allPreview);
  await page.click("#generateButton");
  await page.waitForFunction(() => document.getElementById("resultText").value.includes("path=%2FALL"));
  const all = await result();
  check("G6 mode semua negara -> /ALL (tanpa /ID walau filter ID terisi)", all.includes("path=%2FALL") && !all.includes("path=%2FID"), pathOf(all));

  // country tanpa negara: pesan jelas, tidak ada config (hasil sebelumnya tidak berubah)
  await page.selectOption("#rotateSelect", "country");
  await page.selectOption("#countrySelect", "");
  const countryPreview = await preview();
  check("G7 pratinjau meminta pilih negara dulu", /rotasi · pilih negara dulu/.test(countryPreview), countryPreview);
  const before = await result();
  await page.click("#generateButton");
  await page.waitForFunction(() => document.getElementById("formMessage").textContent.includes("Pilih negara dulu"));
  check("G8 mode negara terpilih tanpa negara -> pesan jelas, tanpa config", (await result()) === before && /Pilih negara dulu/.test(await message()), await message());

  // country + ID: /ID
  await page.selectOption("#countrySelect", "ID");
  check("G9 pratinjau menyebut rotasi /ID", /rotasi · \/ID/.test(await preview()), await preview());
  await page.click("#generateButton");
  await page.waitForFunction(() => document.getElementById("resultText").value.includes("path=%2FID"));
  const country = await result();
  check("G10 mode negara terpilih (ID) -> /ID", country.includes("path=%2FID"), pathOf(country));
});

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} pemeriksaan lolos.`);
if (pageNotes.length) console.log(`Catatan halaman:\n  ${pageNotes.join("\n  ")}`);
process.exit(failed.length ? 1 : 0);
