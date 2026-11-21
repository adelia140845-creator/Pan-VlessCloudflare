// Halaman Status: kondisi pool proxy (Supabase) + kondisi siklus terakhir cron-worker Pan-VlessCloudflare.
//
// Halaman ini sengaja TIDAK memuat app.js: satu-satunya hal yang dibutuhkannya dari sesi adalah
// role, dan role yang diverifikasi server (RPC whoami) dipakai app.js. Di sini role hanya
// menentukan apakah angka ditampilkan, jadi halaman tetap bisa dibuka tanpa menyeret seluruh
// state panel.
//
// Hitungan pool diambil langsung dari PostgREST memakai `Prefer: count=exact` + `Range: 0-0`:
// server mengirim total di header `Content-Range` ("0-0/247", atau "*/0" saat tidak ada baris)
// tanpa mengunduh barisnya, jadi halaman ini tidak pernah menarik seluruh isi proxy_pool.
// Pola ini sama dengan yang dipakai panel/generator untuk membaca pool.
//
// Setiap angka yang tidak bisa didapat ditulis "-" beserta alasannya. Tidak ada angka karangan:
// kolom yang belum dimigrasi, kredensial yang ditolak, dan endpoint cron yang tidak terjangkau
// semuanya berakhir sebagai "-", bukan 0.
//
// Kondisi scanner panproxyscanner dibaca dari GET /api/health (publik, CORS terbuka) dan hanya
// bidang yang benar-benar dikirim balasannya yang ditampilkan (sekarang: ok + time, tanpa versi).
// Angka kandidat/hidup/TLS hanya ada di GET /api/stats yang menolak tanpa kredensial, jadi halaman
// ini menampilkan catatan itu alih-alih menebak angkanya; token API scanner (bila diisi di tab ini)
// dikirim sebagai header X-Api-Token dan tidak pernah disimpan di localStorage maupun ditampilkan.
const SUPABASE_URL = "https://lumbbmhhmkcnxunuryjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bWJibWhobWtjbnh1bnVyeWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzI1MjEsImV4cCI6MjExMDA0ODUyMX0.ylMqMgv2H4vWax-whnXSRHBlD7DZs9DXVRUD9fAO6mc";
// Worker cron Pan-VlessCloudflare adalah Worker terpisah (deploy manual dari cron-worker/). Endpoint /status
// mengirim header CORS supaya halaman ini bisa membacanya.
const CRON_STATUS_URL = "https://proxy-cron-worker.adelia140845.workers.dev/status";
// Scanner proxy (panproxyscanner) adalah layanan terpisah dari worker di atas.
const SCANNER_BASE = "https://panproxyscanner.jhopan.my.id";
// Token API scanner hanya hidup selama tab ini (sessionStorage), bukan localStorage: berbeda
// dengan email + Account ID Cloudflare, token ini bukan identitas panel, jadi tidak ikut tersimpan.
const SCANNER_TOKEN_KEY = "CFVPN-scanner-api-token";
// Batas 8 detik supaya scanner yang mati berakhir sebagai "-", bukan halaman Status yang menggantung.
const SCANNER_TIMEOUT_MS = 8000;
const sessionKey = "CFVPN-vpn-panel-session";
const TABLE = "proxy_pool";
const FRESH_MS = 6 * 3600 * 1000;

const $ = (id) => document.getElementById(id);

// Irisan pool. Semua dibatasi is_active=true supaya yang dihitung adalah isi pool yang sekarang,
// bukan riwayat baris mati. `column` + `hint` dipakai untuk menjelaskan kegagalan 400/404 dari
// PostgREST saat kolom bukti belum ada (migrasi belum dijalankan).
const POOL_SLICES = [
  { id: "total", label: "Aktif", note: "is_active = true", filter: "is_active=eq.true" },
  {
    id: "edgeOk", label: "Terbukti edge", note: "tunnel_ok = true (vonis cron-worker)",
    filter: "is_active=eq.true&tunnel_ok=eq.true",
    column: "tunnel_ok", hint: "sql/2026-11-14-proxy-tunnel-columns.sql",
  },
  {
    id: "edgeDead", label: "Mati di edge", note: "tunnel_ok = false",
    filter: "is_active=eq.true&tunnel_ok=eq.false",
    column: "tunnel_ok", hint: "sql/2026-11-14-proxy-tunnel-columns.sql",
  },
  {
    id: "edgeNull", label: "Belum diprobe", note: "tunnel_ok = null",
    filter: "is_active=eq.true&tunnel_ok=is.null",
    column: "tunnel_ok", hint: "sql/2026-11-14-proxy-tunnel-columns.sql",
  },
  {
    id: "tlsOk", label: "TLS ok", note: "tls_ok = true (vantage host)",
    filter: "is_active=eq.true&tls_ok=eq.true",
    column: "tls_ok", hint: "sql/2026-11-14-proxy-evidence-columns.sql",
  },
  {
    id: "hostOk", label: "Terbukti host", note: "tunnel_host_ok = true (vantage host)",
    filter: "is_active=eq.true&tunnel_host_ok=eq.true",
    column: "tunnel_host_ok", hint: "sql/2026-11-14-tunnel-host-columns.sql",
  },
  {
    id: "fresh",
    label: `Segar < ${FRESH_MS / 3600000} jam`,
    note: "last_checked dalam 6 jam terakhir",
    filter: () => `is_active=eq.true&last_checked=gte.${encodeURIComponent(new Date(Date.now() - FRESH_MS).toISOString())}`,
    column: "last_checked", hint: "kolom last_checked diisi cron-worker/scanner",
  },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("id-ID") : "-";
}

function timeText(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Payload /status memakai ISO UTC; yang ditampilkan waktu lokal browser supaya jamnya bisa
  // langsung dibandingkan dengan jam sekarang. Nilai UTC mentahnya tetap ada di bagian JSON.
  return date.toLocaleString("id-ID", { hour12: false }) + " (waktu lokal)";
}

function ageText(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return minutes + " menit lalu";
  return Math.round(minutes / 60) + " jam lalu";
}

// Satu irisan: hanya header `Content-Range` yang dipakai, badannya dibuang. `Range: 0-0` membuat
// PostgREST mengirim paling banyak satu baris, jadi biayanya tetap sama untuk pool 10 atau 10.000
// baris. Status 206 (ada baris) dan 200 (tidak ada baris, "*/0") sama-sama sah.
async function countSlice(filter) {
  const query = typeof filter === "function" ? filter() : filter;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&${query}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      accept: "application/json",
      prefer: "count=exact",
      range: "0-0",
    },
  });
  const body = await res.text();
  // Semua kegagalan di bawah membawa status HTTP-nya: pesan "-" di halaman harus menyebut kode
  // yang benar-benar dikirim server, bukan "HTTP undefined".
  const fail = (message) => {
    const err = new Error(message);
    err.status = res.status;
    err.code = postgrestCode(body);
    return err;
  };
  if (!res.ok) throw fail(postgrestMessage(body, res.status));
  const total = (res.headers.get("content-range") || "").split("/")[1];
  if (!total || total === "*") throw fail("header Content-Range tidak memuat total");
  const count = Number(total);
  if (!Number.isFinite(count)) throw fail("total bukan angka: " + total);
  return count;
}

function postgrestMessage(body, status) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {}
  return "HTTP " + status;
}

function postgrestCode(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && parsed.code ? String(parsed.code) : "";
  } catch {
    return "";
  }
}

// PostgREST menandai kolom yang tidak dikenal dengan PGRST204/42703; kalau kodenya tidak dikirim
// (mis. worker/proxy lain di tengah jalan) status 400 pada irisan yang memang bergantung pada satu
// kolom tetap diperlakukan sebagai "kolom belum ada", supaya jawabannya "-" + langkah migrasinya,
// bukan 0.
function sliceReason(slice, err) {
  const columnMissing = err.code === "PGRST204" || err.code === "42703" || (err.status === 400 && slice.column);
  if (columnMissing) {
    return `kolom ${slice.column} tidak terbaca (HTTP ${err.status}: ${err.message}) — jalankan ${slice.hint}`;
  }
  return `gagal dibaca (HTTP ${err.status}: ${err.message})`;
}

function renderPoolCard(card) {
  const value = card.querySelector("strong");
  const reason = card.querySelector(".slice-reason");
  if (card.dataset.value !== undefined) {
    value.textContent = num(Number(card.dataset.value));
    reason.textContent = "";
    return;
  }
  value.textContent = "-";
  reason.textContent = card.dataset.reason || "";
}

function buildPoolCards() {
  const host = $("poolStats");
  host.innerHTML = POOL_SLICES.map((slice) => (
    `<article class="stat-card" data-slice="${escapeHtml(slice.id)}">` +
    `<p>${escapeHtml(slice.label)}</p>` +
    `<strong>…</strong>` +
    `<span>${escapeHtml(slice.note)}</span>` +
    `<span class="slice-reason" style="display:block;color:var(--muted);font-size:.72rem"></span>` +
    "</article>"
  )).join("");
}

async function loadPool() {
  const cards = new Map();
  document.querySelectorAll("#poolStats .stat-card").forEach((card) => cards.set(card.dataset.slice, card));
  const problems = [];
  await Promise.all(POOL_SLICES.map(async (slice) => {
    const card = cards.get(slice.id);
    try {
      const count = await countSlice(slice.filter);
      card.dataset.value = String(count);
      card.querySelector("strong").style.color = "";
    } catch (err) {
      delete card.dataset.value;
      const reason = sliceReason(slice, err);
      card.dataset.reason = reason;
      card.querySelector("strong").style.color = "var(--red)";
      problems.push(`${slice.label}: ${reason}`);
    }
    renderPoolCard(card);
  }));
  const msg = $("poolMessage");
  if (problems.length) {
    msg.textContent = problems.join(" | ");
    msg.classList.add("error");
  } else {
    msg.textContent = "Semua irisan terbaca dari Supabase.";
    msg.classList.remove("error");
  }
}

// ---- Cron worker ---------------------------------------------------------------------
// Field yang ditampilkan sesuai objek `lastRun` di cron-worker/src/index.js. Nilai yang tidak ada
// di payload tetap ditulis "-" supaya versi worker lama tidak terlihat seperti "0 baris".
const CRON_FIELDS = [
  { key: "ok", label: "ok", note: "worker menjawab", format: (v) => (v === true ? "true" : v === false ? "false" : "-") },
  { key: "startedAt", label: "startedAt", note: "siklus terakhir mulai", format: (v) => timeText(v) || "-" },
  {
    key: "finishedAt", label: "finishedAt", note: "siklus terakhir selesai",
    format: (v) => {
      const text = timeText(v);
      if (!text) return "-";
      const age = ageText(v);
      return age ? `${text} · ${age}` : text;
    },
  },
  { key: "rows", label: "rows", note: "baris dimuat siklus terakhir", format: num },
  { key: "checked", label: "checked", note: "baris benar-benar diprobe", format: num },
  { key: "tunnel", label: "tunnel", note: "probe tunnel tembus", format: num },
  { key: "disabled", label: "disabled", note: "baris dimatikan siklus ini", format: num },
  { key: "stats.stuck", label: "stats.stuck", note: "baris dipotong penjaga anggaran", format: num },
  {
    key: "tunnelColumns", label: "tunnelColumns", note: "kolom tunnel_ok tersedia di proxy_pool",
    format: (v) => (v === true ? "true (ada)" : v === false ? "false (belum ada — jalankan sql/2026-11-14-proxy-tunnel-columns.sql)" : "-"),
  },
  { key: "error", label: "error", note: "error siklus terakhir", format: (v) => (typeof v === "string" && v ? v : "-") },
];

function readPath(obj, path) {
  return path.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), obj);
}

function renderCron(payload) {
  const rows = CRON_FIELDS.map((field) => {
    const raw = readPath(payload, field.key);
    const shown = raw === undefined || raw === null ? "-" : field.format(raw);
    return `<tr><td><code>${escapeHtml(field.label)}</code></td><td>${escapeHtml(shown)}</td><td style="color:var(--muted)">${escapeHtml(field.note)}</td></tr>`;
  }).join("");
  $("cronRows").innerHTML = rows;
  $("cronRaw").textContent = JSON.stringify(payload, null, 2);
  $("cronState").textContent = payload && payload.ok === true ? "ok" : "-";
  return payload.ok === true;
}

function renderCronFailure(reason) {
  $("cronRows").innerHTML = `<tr><td><code>GET /status</code></td><td>-</td><td style="color:var(--muted)">${escapeHtml(reason)}</td></tr>`;
  $("cronRaw").textContent = "-";
  $("cronState").textContent = "-";
}

async function loadCron() {
  const msg = $("cronMessage");
  msg.classList.add("error");
  try {
    // Tanpa header khusus dan tanpa `cache: no-store`: keduanya memicu preflight CORS atau
    // menambah header non-sederhana, padahal endpoint ini GET sederhana. Kesegaran dijamin
    // parameter `t` + `cache-control: no-store` dari sisi worker.
    const res = await fetch(`${CRON_STATUS_URL}?t=${Date.now()}`, { headers: { accept: "application/json" } });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("respons bukan JSON");
    }
    const ok = renderCron(payload);
    if (ok) {
      msg.textContent = "Terbaca dari " + CRON_STATUS_URL;
      msg.classList.remove("error");
    } else {
      msg.textContent = "Endpoint menjawab, tetapi payload tidak membawa ok=true.";
    }
  } catch (err) {
    const reason = "tidak terbaca dari browser: " + err.message + " (CORS/jaringan/worker belum dideploy)";
    renderCronFailure(reason);
    msg.textContent = reason;
  }
}

// ---- Scanner proxy (panproxyscanner) -------------------------------------------------
// Bidang /api/health yang ditampilkan sesuai balasan sungguhannya (per 2026-11-21: hanya
// `{"ok":true,"time":"..."}`). Baris `versi` tetap ada supaya bidang versi yang mungkin
// ditambahkan scanner nanti ikut tampil tanpa perlu ubah kode; selama tidak dikirim, nilainya "-".
const SCANNER_HEALTH_FIELDS = [
  {
    key: "ok", label: "ok", note: "bidang ok dari /api/health",
    format: (v) => (v === true ? "true (hidup)" : v === false ? "false (mati)" : typeof v === "string" ? v : "-"),
  },
  {
    key: "time", label: "time", note: "jam server scanner (ISO UTC dari scanner)",
    format: (v) => {
      const text = timeText(v);
      if (!text) return "-";
      const age = ageText(v);
      return age ? `${text} · ${age}` : text;
    },
  },
  {
    key: "version", label: "versi", note: "terisi hanya kalau /api/health mengirimnya",
    format: (v) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : "-"),
  },
];

// Nama bidang yang benar-benar ada di balasan, jadi "bidang tersedia" tidak perlu ditebak.
export function scannerFieldList(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "-";
  const keys = Object.keys(payload);
  return keys.length ? keys.join(", ") : "-";
}

export function scannerHealthRows(payload) {
  const rows = SCANNER_HEALTH_FIELDS.map((field) => {
    const raw = readPath(payload, field.key);
    return { label: field.label, value: raw === undefined || raw === null ? "-" : field.format(raw), note: field.note };
  });
  rows.push({ label: "bidang tersedia", value: scannerFieldList(payload), note: "nama bidang yang ada di balasan /api/health" });
  return rows;
}

// Bentuk balasan /api/stats tidak bisa diketahui tanpa token (endpoint menolak tanpa kredensial),
// jadi tidak ada kolom yang dipatok: setiap bidang yang benar-benar dikirim ditampilkan apa adanya
// sampai dua tingkat, lebih dalam dari itu diringkas jadi JSON pendek. Bidang kosong/null -> "-".
export function scannerStatText(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("id-ID") : "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value ? value : "-";
  return "-";
}

function jsonText(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return "-";
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

const DEPTH_NOTE = "diringkas dari /api/stats (lebih dari dua tingkat)";

export function scannerStatRows(payload, prefix = "", depth = 0) {
  // Balasan yang memang kosong tidak menghasilkan baris palsu; bidang kosong di dalam balasan tetap
  // punya barisnya sendiri dengan nilai "-".
  if (payload === null || payload === undefined) {
    return prefix ? [{ label: prefix, value: "-", note: "bidang kosong/null di /api/stats" }] : [];
  }
  if (Array.isArray(payload)) {
    if (!payload.length) return [];
    if (depth >= 2) return [{ label: prefix || "(akar)", value: jsonText(payload), note: DEPTH_NOTE }];
    return payload.flatMap((item, index) => scannerStatRows(item, `${prefix}[${index}]`, depth + 1));
  }
  if (typeof payload === "object") {
    const entries = Object.entries(payload);
    if (!entries.length) return [];
    if (depth >= 2) return [{ label: prefix || "(akar)", value: jsonText(payload), note: DEPTH_NOTE }];
    return entries.flatMap(([key, value]) => scannerStatRows(value, prefix ? `${prefix}.${key}` : key, depth + 1));
  }
  return [{ label: prefix || "(akar)", value: scannerStatText(payload), note: "apa adanya dari /api/stats" }];
}

// Timer abort: scanner yang tidak menjawab dalam 8 detik berhenti sebagai "-". Header yang dikirim
// hanya `accept` (dan `x-api-token` saat token diisi), jadi permintaan tanpa token tetap sederhana
// dan tidak memicu preflight; /api/stats memang mengizinkan header itu di CORS-nya.
async function fetchScanner(path, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS);
  try {
    const headers = { accept: "application/json" };
    if (token) headers["x-api-token"] = token;
    const res = await fetch(`${SCANNER_BASE}${path}`, { headers, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      // Balasan galat scanner juga berbentuk {"error": "..."}, jadi helper PostgREST dipakai ulang.
      const err = new Error(postgrestMessage(body, res.status));
      err.status = res.status;
      throw err;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("respons bukan JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function scannerReason(err) {
  if (err && err.name === "AbortError") return `tidak menjawab dalam ${SCANNER_TIMEOUT_MS / 1000} detik`;
  return String((err && err.message) || err);
}

function renderRows(tbodyId, rows) {
  $(tbodyId).innerHTML = rows.map((row) => (
    `<tr><td><code>${escapeHtml(row.label)}</code></td><td>${escapeHtml(row.value)}</td>` +
    `<td style="color:var(--muted)">${escapeHtml(row.note || "")}</td></tr>`
  )).join("");
}

// Token dibaca/ditulis hanya lewat dua fungsi ini supaya nilainya tidak pernah bocor ke pesan,
// judul, atau JSON yang ditampilkan.
function readScannerToken() {
  try {
    return sessionStorage.getItem(SCANNER_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function writeScannerToken(value) {
  try {
    if (value) sessionStorage.setItem(SCANNER_TOKEN_KEY, value);
    else sessionStorage.removeItem(SCANNER_TOKEN_KEY);
  } catch {}
}

async function loadScanner() {
  const msg = $("scannerMessage");
  msg.classList.add("error");
  try {
    const payload = await fetchScanner("/api/health");
    renderRows("scannerRows", scannerHealthRows(payload));
    $("scannerRaw").textContent = JSON.stringify(payload, null, 2);
    $("scannerState").textContent = payload && payload.ok === true ? "hidup" : "-";
    msg.textContent = `Terbaca dari ${SCANNER_BASE}/api/health`;
    msg.classList.remove("error");
  } catch (err) {
    const reason = scannerReason(err);
    renderRows("scannerRows", [{ label: "GET /api/health", value: "-", note: `${reason} (CORS/jaringan/scanner belum jalan)` }]);
    $("scannerRaw").textContent = "-";
    $("scannerState").textContent = "-";
    msg.textContent = reason;
  }
  await loadScannerStats();
}

async function loadScannerStats() {
  const msg = $("statsMessage");
  const where = `angka lengkap (kandidat/hidup/TLS) ada di UI scanner: ${SCANNER_BASE}`;
  const token = readScannerToken();
  if (!token) {
    renderRows("statsRows", [{ label: "GET /api/stats", value: "-", note: "token API scanner belum diisi — " + where }]);
    $("statsRaw").textContent = "-";
    msg.textContent = "Token API scanner belum diisi, jadi angka /api/stats tidak diminta. " + where + ".";
    msg.classList.remove("error");
    return;
  }
  msg.classList.add("error");
  try {
    const payload = await fetchScanner("/api/stats", token);
    const rows = scannerStatRows(payload);
    renderRows("statsRows", rows.length ? rows : [{ label: "(akar)", value: "-", note: "balasan /api/stats tidak memuat bidang" }]);
    $("statsRaw").textContent = JSON.stringify(payload, null, 2);
    msg.textContent = `Terbaca dari ${SCANNER_BASE}/api/stats`;
    msg.classList.remove("error");
  } catch (err) {
    const reason = err && (err.status === 401 || err.status === 403) ? `token ditolak (${err.message})` : scannerReason(err);
    renderRows("statsRows", [{ label: "GET /api/stats", value: "-", note: reason }]);
    $("statsRaw").textContent = "-";
    msg.textContent = `${reason}. ${where}.`;
  }
}

// ---- Halaman -------------------------------------------------------------------------
function readSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(sessionKey) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function renderProfile(session) {
  const role = typeof session.role === "string" && session.role ? session.role : "user";
  document.querySelectorAll("[data-user-email]").forEach((el) => {
    el.innerHTML = `${escapeHtml(session.username || "")} <span class="role-badge ${escapeHtml(role)}">${escapeHtml(role)}</span>`;
  });
  if (role === "admin") {
    const nav = $("adminNav");
    if (nav) nav.hidden = false;
  }
}

async function refresh() {
  const button = $("refreshButton");
  button.disabled = true;
  button.textContent = "Memuat…";
  $("fetchedAt").textContent = "Mengambil…";
  try {
    await Promise.all([loadPool(), loadCron(), loadScanner()]);
    $("fetchedAt").textContent = "Terakhir diambil " + new Date().toLocaleTimeString("id-ID", { hour12: false });
  } finally {
    button.disabled = false;
    button.textContent = "↻ Refresh";
  }
}

function init() {
  const session = readSession();
  if (!session) {
    location.replace("landing.html");
    return;
  }
  renderProfile(session);
  $("logoutButton")?.addEventListener("click", () => {
    localStorage.removeItem(sessionKey);
    location.href = "login.html";
  });

  if (session.role !== "admin") {
    $("deniedPanel").hidden = false;
    $("deniedText").textContent =
      `Halaman ini hanya menampilkan data pool dan cron-worker untuk sesi berrole admin. ` +
      `Sesi Anda (${session.username || "?"}) berrole "${session.role || "user"}", jadi tidak ada angka yang ditampilkan.`;
    $("refreshButton").disabled = true;
    $("fetchedAt").textContent = "-";
    return;
  }

  $("statusData").hidden = false;
  buildPoolCards();
  $("refreshButton").addEventListener("click", refresh);
  const tokenInput = $("scannerToken");
  tokenInput.value = readScannerToken();
  // Simpan saat tombol ditekan atau saat isian ditinggalkan; keduanya memicu satu jalan yang sama.
  const applyToken = () => {
    writeScannerToken(tokenInput.value.trim());
    loadScannerStats();
  };
  $("scannerTokenBtn").addEventListener("click", applyToken);
  tokenInput.addEventListener("change", applyToken);
  refresh();
}

// Di browser selalu jalan. Di Node (tes) `document` tidak ada, jadi modul ini bisa diimpor untuk
// menguji fungsi murninya tanpa efek samping ke DOM/localStorage.
if (typeof document !== "undefined") init();
