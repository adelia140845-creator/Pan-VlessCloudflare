// Halaman Status: kondisi pool proxy (Supabase) + kondisi siklus terakhir cron-worker CFVPN.
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
const SUPABASE_URL = "https://lumbbmhhmkcnxunuryjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bWJibWhobWtjbnh1bnVyeWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzI1MjEsImV4cCI6MjExMDA0ODUyMX0.ylMqMgv2H4vWax-whnXSRHBlD7DZs9DXVRUD9fAO6mc";
// Worker cron CFVPN adalah Worker terpisah (deploy manual dari cron-worker/). Endpoint /status
// mengirim header CORS supaya halaman ini bisa membacanya.
const CRON_STATUS_URL = "https://proxy-cron-worker.adelia140845.workers.dev/status";
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
    await Promise.all([loadPool(), loadCron()]);
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
  refresh();
}

init();
