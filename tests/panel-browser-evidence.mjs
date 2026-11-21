// Bukti browser untuk empat fitur panel (Playwright, Chromium headless):
//   A. admin.html   — Reset sandi + Buka kunci lewat RPC admin_action (sukses & migrasi belum ada)
//   B. workers.html — Edit data worker (tersimpan, dan validasi menolak UUID/host/Account ID salah)
//   C. workers.html — Kuota dimuat otomatis dari localStorage untuk 2 akun (maks 3, berurutan)
//   D. workers.html — "Tetapkan token" LB (32 hex) menulis state tanpa memanggil Cloudflare
//   F. proxy.html   — tabel ringkasan per negara, tombol urut, tombol copy per baris
//
// Semua jaringan dipalsukan: berkas frontend disajikan server lokal Node, impor CDN
// @supabase/supabase-js dijawab stub oleh satu route handler, dan /api/workers-stats di-intercept.
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
// skenario C — email/Account ID yang "diingat" serta simpanan kuota bentuk lama.
function applyConfig(config) {
  window.__config = config;
  try {
    localStorage.setItem("CFVPN-vpn-panel-session", JSON.stringify(config.session));
    if (config.remembered) {
      localStorage.setItem("statsCfEmail", config.remembered.email);
      localStorage.setItem("statsCfAccountId", config.remembered.accountId);
    }
    if (config.legacySnapshot) {
      localStorage.setItem("accountQuotaGate", JSON.stringify({
        v: 1,
        day: new Date().toISOString().slice(0, 10),
        savedAt: Date.now(),
        quota: 100000,
        threshold: 90,
        accounts: { "acc-lama": { used: 1000, errors: 0, percent: 1, remaining: 99000, level: "ok", blocked: false, workers: [{ id: "w1", name: "cfvpn-vpn-sg", used: 1000, errors: 0 }] } },
        unattributed: [],
      }));
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
// tiap skenario butuh state berbeda. Server worker (health) dan /api/workers-stats dipalsukan;
// sisa host luar di-abort supaya tidak ada permintaan sungguhan yang keluar.
async function withPanel(config, run) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(applyConfig, config);
  const net = { stats: [] };
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
    if (url.includes("/api/workers-stats")) {
      const body = JSON.parse(route.request().postData() || "{}");
      net.stats.push(body);
      if (config.statsFailure) {
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Cloudflare menolak.", needsScope: true }) });
      }
      const results = {};
      for (const name of body.scriptNames || []) {
        results[name] = { requests: name === "cfvpn-vpn-jp" ? 95000 : 2000, errors: name === "cfvpn-vpn-jp" ? 3 : 0 };
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, results: results, from: "2026-11-21T00:00:00Z", to: "2026-11-21T10:00:00Z" }),
      });
    }
    if (url.includes("/health")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, type: "vpn", version: "2026-11-15b" }) });
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

// --------------------------------- C. kuota otomatis (2 akun, dari localStorage)
const QUOTA_STATE = {
  generatedCount: 0,
  workers: [
    { id: "w1", name: "cfvpn-vpn-sg", host: "vpn1.user.workers.dev", type: "vpn", active: true, accountId: "acc-a" },
    { id: "w2", name: "cfvpn-vpn-jp", host: "vpn2.user.workers.dev", type: "vpn", active: true, accountId: "acc-b" },
  ],
};

await withPanel({ session: SESSION, role: "admin", state: QUOTA_STATE, remembered: { email: "bos@contoh.id", accountId: "acc-a" } }, async (page, h) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector("#statsCfEmail");
  const restored = await page.evaluate(() => ({
    email: document.getElementById("statsCfEmail").value,
    account: document.getElementById("statsCfAccountId").value,
    key: document.getElementById("statsCfApiKey").value,
  }));
  check("C1 email + Account ID diingat dari localStorage, kunci API TIDAK disimpan", restored.email === "bos@contoh.id" && restored.account === "acc-a" && restored.key === "", JSON.stringify(restored));

  // Kunci API tidak pernah disimpan, jadi pemuatan otomatis menunggu isian ini (tetap tanpa klik).
  await page.fill("#statsCfApiKey", "kunci-uji");
  await page.dispatchEvent("#statsCfApiKey", "change");
  await page.waitForFunction(() => document.getElementById("quotaFetchedAt").textContent.includes("2/2 akun"));
  check("C2 dua akun dimuat otomatis TANPA klik tombol Muat ulang", h.net.stats.length === 2, `permintaan: ${h.net.stats.map((b) => b.accountId).join(", ")}`);
  check("C3 tiap akun dikirim sebagai permintaannya sendiri, berurutan", JSON.stringify(h.net.stats.map((b) => b.accountId)) === JSON.stringify(["acc-a", "acc-b"]));
  check("C4 tiap permintaan hanya membawa nama script akun itu", h.net.stats.every((b) => (b.scriptNames || []).length === 1), JSON.stringify(h.net.stats.map((b) => b.scriptNames)));

  const table = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#quotaTable tbody tr")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim());
    return { rows: rows, accounts: [...document.querySelectorAll("#quotaTable code")].map((c) => c.textContent) };
  });
  check("C5 tabel kuota punya baris untuk tiap akun", table.accounts.includes("acc-a") && table.accounts.includes("acc-b"), JSON.stringify(table.accounts));
  check("C6 akun yang mencapai ambang ditandai di tabel", table.rows.some((row) => row.includes("95% terpakai")), JSON.stringify(table.rows));
  check("C7 gate memblokir worker akun yang melewati ambang (kartu worker)", await page.evaluate(() => document.body.innerHTML.includes("kuota akun 95%")));

  const snapshot = await page.evaluate(() => ({
    keys: Object.keys(localStorage).filter((key) => key.startsWith("accountQuotaGate:")),
    a: JSON.parse(localStorage.getItem("accountQuotaGate:acc-a") || "null"),
    b: JSON.parse(localStorage.getItem("accountQuotaGate:acc-b") || "null"),
  }));
  check("C8 snapshot disimpan per akun dengan tanggal UTC", Boolean(snapshot.a) && Boolean(snapshot.b) && snapshot.a.account.used === 2000 && snapshot.b.account.used === 95000 && snapshot.a.day === new Date().toISOString().slice(0, 10), JSON.stringify(snapshot.keys));
});

// C. simpanan bentuk lama (satu kunci berisi semua akun) tetap dibaca
await withPanel({ session: SESSION, role: "admin", state: QUOTA_STATE, legacySnapshot: true }, async (page) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector("#quotaTable code");
  const accounts = await page.evaluate(() => [...document.querySelectorAll("#quotaTable code")].map((c) => c.textContent));
  check("C9 kunci lama accountQuotaGate tetap dibaca", accounts.includes("acc-lama"), JSON.stringify(accounts));
});

// C. lebih dari 3 akun: hanya 3 dimuat, sisanya disebutkan namanya
const MANY_QUOTA_STATE = {
  generatedCount: 0,
  workers: ["acc-a", "acc-b", "acc-c", "acc-d"].map((accountId, index) => ({
    id: `w${index + 1}`,
    name: `cfvpn-vpn-${index + 1}`,
    host: `vpn${index + 1}.user.workers.dev`,
    type: "vpn",
    active: true,
    accountId: accountId,
  })),
};

await withPanel({ session: SESSION, role: "admin", state: MANY_QUOTA_STATE, remembered: { email: "bos@contoh.id", accountId: "acc-a" } }, async (page, h) => {
  await page.goto(`${BASE}/workers.html`);
  await page.waitForSelector("#statsCfApiKey");
  await page.fill("#statsCfApiKey", "kunci-uji");
  await page.dispatchEvent("#statsCfApiKey", "change");
  await page.waitForFunction(() => document.getElementById("quotaFetchedAt").textContent.includes("3/3 akun"));
  check("C10 maksimal 3 akun dimuat dari 4 Account ID", h.net.stats.length === 3 && JSON.stringify(h.net.stats.map((b) => b.accountId)) === JSON.stringify(["acc-a", "acc-b", "acc-c"]), JSON.stringify(h.net.stats.map((b) => b.accountId)));
  check("C11 akun yang belum dimuat disebutkan namanya", /akun belum dimuat .*acc-d/.test(await page.evaluate(() => document.getElementById("quotaFetchedAt").textContent)), await page.evaluate(() => document.getElementById("quotaFetchedAt").textContent));
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

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} pemeriksaan lolos.`);
if (pageNotes.length) console.log(`Catatan halaman:\n  ${pageNotes.join("\n  ")}`);
process.exit(failed.length ? 1 : 0);
