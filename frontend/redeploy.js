// Logika murni untuk halaman Workers/Deploy: tombol "Deploy ulang semua Worker tersimpan"
// (halaman Deploy), helper token langganan Load Balancer yang dipakai jalur deploy tunggal dan
// tampilan URL langganan, riwayat pemeriksaan /health (uptime) yang ditampilkan di kartu worker,
// validasi isian form worker, dan simpanan kuota per akun. Dipisah dari app.js supaya bisa diuji
// `node:test` tanpa DOM, Jaringan, maupun Cloudflare.

// Template per jenis worker. Nilainya HARUS sama dengan jalur deploy tunggal di renderDeploy
// (app.js): satu template VPN untuk semua tier + satu template Load Balancer.
export const REDEPLOY_TEMPLATES = {
  vpn: "/source/panvlesscloudflare.js",
  load_balancer: "/source/load-balancer.js",
};

// --- Token langganan Load Balancer -------------------------------------------

// 16 byte acak -> 32 karakter hex, cukup untuk token langganan (bukan sandi akun).
export const SUB_TOKEN_BYTES = 16;

// createSubToken: token acak 32 karakter hex. Sumber acaknya bisa disuntik untuk uji, bawaan
// crypto.getRandomValues (tersedia di browser maupun Worker).
export function createSubToken(getRandomValues = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(SUB_TOKEN_BYTES);
  getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ensureSubToken: pakai token worker apa adanya kalau sudah ada. Deploy ulang nama script yang
// sama TIDAK boleh membuat token baru — tautan langganan yang sudah dibagikan ke user akan mati
// kalau tokennya berputar. Token hanya dibuat untuk worker LB yang belum punya.
export function ensureSubToken(worker, getRandomValues) {
  const stored = typeof worker?.sub_token === "string" ? worker.sub_token.trim() : "";
  return stored || createSubToken(getRandomValues);
}

// withSubToken menyisipkan token langganan ke URL LB sebagai parameter `t` (nama yang dibaca
// template LB). Tanpa token URL dikembalikan apa adanya (LB lama yang belum punya binding
// SUB_TOKEN memang terbuka), dan URL yang sudah memuat `t` tidak ditulis dua kali. Sengaja tanpa
// `new URL()`: kartu worker menampilkan URL tanpa skema.
export function withSubToken(url, token) {
  const clean = typeof token === "string" ? token.trim() : "";
  if (!clean || typeof url !== "string" || !url) return url;
  if (/[?&]t=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(clean)}`;
}

// Binding env satu worker, disusun seperti deploy tunggal:
//   - VPN: UUID dikunci lewat UUID_ALLOWLIST (worker menolak UUID lain);
//   - Load Balancer: daftar VPN Worker yang terhubung dikirim sebagai VPN_DOMAINS, nama env
//     yang dibaca template LB (lihat /source/load-balancer.js) sebagai daftar domain cadangan
//     saat URL langganan tidak menyebut parameter `domains`, dan token langganan worker dikirim
//     sebagai SUB_TOKEN. Token di sini HANYA dibaca dari state (tidak pernah dibuat baru):
//     deploy ulang massal tidak boleh memutar token, supaya tautan langganan lama tetap jalan.
//     LB tersimpan yang belum punya token tetap dikirim tanpa SUB_TOKEN (terbuka, seperti dulu).
export function redeployVars(worker) {
  const vars = {};
  const uuid = typeof worker?.uuid === "string" ? worker.uuid.trim() : "";
  if (uuid) vars.UUID_ALLOWLIST = uuid;

  if (worker?.type === "load_balancer") {
    const domains = (Array.isArray(worker.vpn_domains) ? worker.vpn_domains : [])
      .map((domain) => String(domain).trim())
      .filter(Boolean);
    if (domains.length) vars.VPN_DOMAINS = domains.join(",");

    const token = typeof worker.sub_token === "string" ? worker.sub_token.trim() : "";
    if (token) vars.SUB_TOKEN = token;
  }

  return vars;
}

// redeployPlan menyusun urutan deploy ulang: satu langkah per worker tersimpan, urutannya sama
// dengan urutan di state. Loop di app.js menjalankannya satu per satu (sekuential), jadi urutan
// ini juga urutan permintaan ke /api/cf. Worker tanpa nama dilewati (tidak bisa jadi scriptName).
export function redeployPlan(workers) {
  return (Array.isArray(workers) ? workers : [])
    .filter((worker) => worker && typeof worker.name === "string" && worker.name.trim())
    .map((worker) => {
      const type = worker.type === "load_balancer" ? "load_balancer" : "vpn";
      return {
        id: worker.id ?? null,
        name: worker.name.trim(),
        type,
        template: REDEPLOY_TEMPLATES[type],
        vars: redeployVars({ ...worker, type }),
      };
    });
}

// redeployProgressLine menyusun satu baris progres: "deploy 3/12: nama — sukses".
// `result` kosong/undefined = permintaan belum selesai.
export function redeployProgressLine(index, total, name, result) {
  if (!result) return `deploy ${index}/${total}: ${name} — mengirim template...`;
  if (result.ok) return `deploy ${index}/${total}: ${name} — sukses`;
  return `deploy ${index}/${total}: ${name} — gagal (${result.error || "alasan tidak diketahui"})`;
}

// rateLimitInfo menerjemahkan balasan /api/cf: 429 berarti jatah permintaan per IP (bawaan
// 10 permintaan / 600 detik) habis, jadi loop harus BERHENTI, bukan diulang otomatis.
// Retry-After diambil dari header (diisi functions/api/cf.js), teks pesannya jadi cadangan.
export function rateLimitInfo(status, retryAfterHeader, data) {
  if (status !== 429) return { limited: false, retryAfter: null };

  const fromHeader = parseInt(String(retryAfterHeader ?? ""), 10);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return { limited: true, retryAfter: fromHeader };

  const match = /(\d+)\s*detik/i.exec(String(data?.error ?? ""));
  const fromBody = match ? parseInt(match[1], 10) : NaN;
  return { limited: true, retryAfter: Number.isFinite(fromBody) && fromBody > 0 ? fromBody : null };
}

// summarizeRedeploy merangkum hasil loop: jumlah sukses/gagal, dan — kalau ada balasan 429 —
// berapa worker yang dilewati karena limit beserta lama menunggunya. `plannedTotal` adalah
// jumlah langkah di redeployPlan; hasil yang belum tercatat sampai loop berhenti dihitung
// sebagai "dilewati", bukan "gagal", karena permintaannya memang tidak pernah dikirim.
export function summarizeRedeploy(results, plannedTotal) {
  const list = Array.isArray(results) ? results : [];
  const succeeded = list.filter((item) => item && item.ok).length;
  const failed = list.filter((item) => item && !item.ok && !item.limited);
  const limited = list.find((item) => item && item.limited) || null;
  const planned = Number.isInteger(plannedTotal) && plannedTotal >= list.length ? plannedTotal : list.length;
  const skipped = limited ? planned - list.length : 0;

  let message = `Ringkasan: ${succeeded} sukses, ${failed.length} gagal.`;

  if (limited) {
    const wait = limited.retryAfter
      ? `coba lagi setelah ${limited.retryAfter} detik`
      : "coba lagi setelah jendela rate limit lewat";
    message += ` Sisanya (${skipped} worker) dilewati karena limit 10 permintaan/10 menit; ${wait}.`;
  }

  if (failed.length) {
    const shown = failed.slice(0, 5).map((item) => `${item.name} (${item.error || "tanpa alasan"})`);
    const rest = failed.length - shown.length;
    message += ` Gagal: ${shown.join("; ")}${rest > 0 ? `; +${rest} gagal lain` : ""}.`;
  }

  return {
    planned,
    sent: list.length,
    ok: succeeded,
    failed: failed.length,
    skipped,
    stopped: Boolean(limited),
    retryAfter: limited ? limited.retryAfter : null,
    failedNames: failed.map((item) => item.name),
    message,
  };
}

// --- Riwayat uptime /health per worker (halaman Workers) ---------------------

// Kunci localStorage riwayat pemeriksaan: satu objek { [workerId]: sampel[] }.
export const WORKER_HEALTH_CACHE_KEY = "workerHealthCache";
// Berapa pemeriksaan TERAKHIR yang disimpan per worker. Kartu hanya membutuhkan tren singkat,
// dan angka ini yang membatasi besar localStorage (20 sampel × jumlah worker).
export const HEALTH_HISTORY_LIMIT = 20;

// healthSampleFromProbe menormalkan hasil satu pemeriksaan `/health` menjadi satu sampel riwayat.
// `reachable` = permintaan benar-benar dijawab worker (fetch selesai, status apa pun). Worker
// dianggap HIDUP kalau dijawab dengan status < 500: 4xx berarti worker ada dan menjawab (mis.
// /health dikunci HEALTH_TOKEN), sedangkan 5xx atau jaringan mati berarti worker bermasalah.
export function healthSampleFromProbe(probe) {
  const source = probe && typeof probe === "object" ? probe : {};
  const status = Number.isFinite(source.status) ? Math.trunc(source.status) : 0;
  const latencyMs = Number.isFinite(source.latencyMs) && source.latencyMs >= 0 ? Math.round(source.latencyMs) : null;
  const version = typeof source.version === "string" && source.version.trim() ? source.version.trim() : null;
  // Jenis worker yang MENGaku dari balasan /health (template VPN lama tidak mengirimnya). Dipakai
  // memutuskan versi template mana yang boleh dibandingkan (lihat versionStateFromHealth).
  const type = typeof source.type === "string" && source.type.trim() ? source.type.trim().toLowerCase() : null;
  const error = typeof source.error === "string" && source.error.trim() ? source.error.trim() : null;

  return {
    at: Number.isFinite(source.at) ? source.at : Date.now(),
    up: source.reachable === true && status < 500,
    status: status,
    latencyMs: latencyMs,
    version: version,
    type: type,
    error: error,
  };
}

// normalizeHealthHistory menyaring isi cache dari localStorage: isi yang bukan objek (rusak/tua)
// dibuang, bukan dibiarkan menjatuhkan render kartu.
function normalizeHealthHistory(history) {
  return (Array.isArray(history) ? history : []).filter((item) => item && typeof item === "object");
}

// appendHealthSample menambah satu sampel ke riwayat worker: sampel terbaru di AKHIR, dan hanya
// HEALTH_HISTORY_LIMIT sampel terakhir yang disimpan (yang lama dibuang, bukan menumpuk).
export function appendHealthSample(history, sample, limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : HEALTH_HISTORY_LIMIT;
  return normalizeHealthHistory(history).concat([sample]).slice(-max);
}

// summarizeHealthHistory merangkum riwayat untuk ditampilkan di kartu: berapa kali diperiksa,
// berapa kali hidup, persen uptime, latensi rata-rata saat hidup, dan sampel terakhir.
// Riwayat kosong menghasilkan uptimePct `null` (belum ada bukti), BUKAN 0 — kartu tidak boleh
// menuduh worker mati sebelum pernah diperiksa.
export function summarizeHealthHistory(history) {
  const samples = normalizeHealthHistory(history);
  const up = samples.filter((item) => item.up === true).length;
  const latencies = samples
    .filter((item) => item.up === true && Number.isFinite(item.latencyMs) && item.latencyMs > 0)
    .map((item) => item.latencyMs);
  const last = samples.length ? samples[samples.length - 1] : null;

  return {
    checks: samples.length,
    up: up,
    down: samples.length - up,
    uptimePct: samples.length ? Math.round((up / samples.length) * 100) : null,
    avgLatencyMs: latencies.length
      ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length)
      : null,
    last: last,
    lastAt: last && Number.isFinite(last.at) ? last.at : null,
    lastUp: last ? last.up === true : null,
    lastStatus: last && Number.isFinite(last.status) ? last.status : null,
    lastLatencyMs: last && Number.isFinite(last.latencyMs) ? last.latencyMs : null,
    lastVersion: last && typeof last.version === "string" ? last.version : null,
    lastType: last && typeof last.type === "string" ? last.type : null,
    lastError: last && typeof last.error === "string" ? last.error : null,
  };
}

// workerVersionState membandingkan dua penanda versi apa adanya:
//   "current" = sama, "stale" = beda (worker perlu deploy ulang), "unknown" = salah satunya kosong
//   (worker belum menjawab /health, atau template tanpa versi). Pemilihan pasangan versi yang
//   benar (VPN vs Load Balancer) ada di versionStateFromHealth.
export function workerVersionState(version, templateVersion) {
  const have = typeof version === "string" ? version.trim() : "";
  const want = typeof templateVersion === "string" ? templateVersion.trim() : "";
  if (!have || !want) return "unknown";
  return have === want ? "current" : "stale";
}

// workerKind menormalkan jenis worker dari state panel: apa pun selain "load_balancer" adalah
// worker VPN (sama seperti typeLabel).
function workerKind(type) {
  return type === "load_balancer" ? "load_balancer" : "vpn";
}

// versionStateFromHealth memutuskan status versi satu worker dari isi balasan /health:
//   health      = { type, version } seperti yang dibalas template (type boleh kosong),
//   workerType  = jenis worker di state panel ("vpn" | "load_balancer"),
//   templates   = { vpn: <versi template VPN di panel>, load_balancer: <versi template LB> }.
//
// Aturannya: angka versi HANYA dibandingkan dengan versi template jenis worker itu sendiri, dan
// hanya kalau balasan /health memang datang dari template jenis tersebut. Jadi kartu Load Balancer
// tidak pernah dituduh "versi lama" hanya karena angkanya berbeda dengan versi template VPN.
//   - `type` sama dengan jenis worker -> bandingkan (current/stale),
//   - `type` kosong (template lama yang belum membalas `type`) -> dianggap template jenis worker
//     itu sendiri, jadi perilaku lama (badge versi VPN) tidak berubah,
//   - `type` dikenal tapi BEDA jenis, atau nilainya tidak dikenal -> "unknown" (jangan menuduh),
//   - versi tidak ada di balasan -> "unknown".
export function versionStateFromHealth(health, workerType, templates) {
  const kind = workerKind(workerType);
  const table = templates && typeof templates === "object" ? templates : {};
  const reported = health && typeof health.type === "string" ? health.type.trim().toLowerCase() : "";

  if (reported && reported !== "vpn" && reported !== "load_balancer") return "unknown";
  if (reported && reported !== kind) return "unknown";

  return workerVersionState(health ? health.version : "", table[kind]);
}

// formatCheckedAt menuliskan kapan pemeriksaan terakhir terjadi, dalam bahasa kartu.
export function formatCheckedAt(at, nowMs) {
  if (!Number.isFinite(at)) return "belum pernah";
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "baru saja";
  if (seconds < 60) return seconds + " detik lalu";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + " menit lalu";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " jam lalu";
  return Math.round(hours / 24) + " hari lalu";
}

// pruneHealthCache membuang riwayat milik worker yang sudah tidak ada di state (kartu dihapus)
// dan memangkas tiap riwayat ke HEALTH_HISTORY_LIMIT, supaya localStorage tidak tumbuh terus.
export function pruneHealthCache(cache, workers) {
  const source = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  const ids = new Set(
    (Array.isArray(workers) ? workers : []).map((worker) => (worker && worker.id ? String(worker.id) : "")).filter(Boolean)
  );
  const kept = {};
  for (const [id, history] of Object.entries(source)) {
    if (!ids.has(id)) continue;
    kept[id] = normalizeHealthHistory(history).slice(-HEALTH_HISTORY_LIMIT);
  }
  return kept;
}

// --- Penjaga kuota per akun Cloudflare --------------------------------------
// Kuota request harian Cloudflare dihitung PER AKUN, bukan per worker: sepuluh worker dalam satu
// akun berbagi satu jatah. Karena itu pemakaian yang dipakai gate adalah jumlah request semua
// worker milik akun itu (satu panggilan /api/workers-stats dengan `scriptNames`), bukan angka per
// worker — angka per worker bisa terlihat aman padahal akunnya sudah di ujung batas.
export const ACCOUNT_QUOTA_THRESHOLD_KEY = "accountQuotaThreshold";
// Ambang gate: 90% supaya masih ada ruang untuk request yang sudah telanjur berjalan sebelum
// kuota benar-benar habis (worker tetap melayani, hanya berhenti DITAWARKAN untuk config baru).
export const ACCOUNT_QUOTA_THRESHOLD_DEFAULT = 90;
export const ACCOUNT_QUOTA_THRESHOLD_MIN = 50;
export const ACCOUNT_QUOTA_THRESHOLD_MAX = 100;

// clampQuotaThreshold menjepit isian ambang ke 50-100%. Nilai tidak sah kembali ke bawaan 90 —
// bukan ke 0 (gate selalu menyala) atau 100 (gate praktis mati) yang bisa terjadi kalau angka
// kosong/rusak dibiarkan lewat.
export function clampQuotaThreshold(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return ACCOUNT_QUOTA_THRESHOLD_DEFAULT;
  return Math.min(ACCOUNT_QUOTA_THRESHOLD_MAX, Math.max(ACCOUNT_QUOTA_THRESHOLD_MIN, parsed));
}

// quotaGate memutuskan satu akun dari pemakaian hari ini:
//   { blocked, percent, remaining, level }
//   level "ok" (<80%), "warn" (80-100%), "over" (>100%), "unknown" (data tidak sah).
// Data yang tidak sah (kuota kosong/0, `used` negatif atau bukan angka) menghasilkan level
// "unknown" dan `blocked: false`: gate TIDAK PERNAH memblokir tanpa data pemakaian, karena worker
// yang disembunyikan tanpa bukti lebih berbahaya daripada kuota yang belum tentu penuh.
// `blocked` menyala tepat saat percent >= threshold, termasuk saat persis di ambang.
export function quotaGate(input) {
  const source = input && typeof input === "object" ? input : {};
  const threshold = clampQuotaThreshold(
    source.threshold === undefined || source.threshold === null ? ACCOUNT_QUOTA_THRESHOLD_DEFAULT : source.threshold
  );
  const used = Number(source.used);
  const quota = Number(source.quota);
  const valid = Number.isFinite(used) && used >= 0 && Number.isFinite(quota) && quota > 0;
  if (!valid) return { blocked: false, percent: null, remaining: null, level: "unknown" };

  // Satu angka di belakang koma cukup untuk ditampilkan; keputusan level memakai rasio mentah
  // supaya pemakaian yang sedikit melewati kuota tidak tersamar jadi tepat 100%.
  const percent = Math.round((used / quota) * 1000) / 10;
  const ratio = (used / quota) * 100;
  const level = ratio >= 100 ? "over" : ratio >= 80 ? "warn" : "ok";
  return { blocked: percent >= threshold, percent: percent, remaining: quota - used, level: level };
}

// groupUsageByAccount mengelompokkan worker per akun Cloudflare dan menjumlahkan pemakaiannya:
//   workers = entri state.workers ({ id, name, accountId?, ... })
//   results = `results` dari /api/workers-stats ({ [scriptName]: { requests, errors } })
//   fallbackAccountId = Account ID yang diisi di panel, dipakai untuk worker lama yang belum
//     menyimpan accountId (asumsi satu akun — disebutkan di UI panel kuota).
// Hasil: Map accountId -> { accountId, workers, used, errors }. Worker tanpa hasil sama sekali
// dihitung 0 request (bukan dibuang), sedangkan worker yang akunnya tidak bisa ditentukan
// (tanpa accountId dan tanpa fallback) TIDAK dimasukkan: pemakaian yang tidak bisa diatribusikan
// tidak boleh membuat akun lain tampak penuh.
export function groupUsageByAccount(workers, results, fallbackAccountId) {
  const source = results && typeof results === "object" && !Array.isArray(results) ? results : {};
  const fallback = typeof fallbackAccountId === "string" ? fallbackAccountId.trim() : "";
  const groups = new Map();

  for (const worker of Array.isArray(workers) ? workers : []) {
    if (!worker || typeof worker !== "object") continue;
    const own = typeof worker.accountId === "string" ? worker.accountId.trim() : "";
    const accountId = own || fallback;
    if (!accountId) continue;

    const name = String(worker.name || "").trim();
    const row = name && Object.prototype.hasOwnProperty.call(source, name) ? source[name] : null;
    const requests = row ? Number(row.requests) : 0;
    const errors = row ? Number(row.errors) : 0;

    if (!groups.has(accountId)) groups.set(accountId, { accountId: accountId, workers: [], used: 0, errors: 0 });
    const group = groups.get(accountId);
    group.workers.push(worker);
    group.used += Number.isFinite(requests) && requests > 0 ? requests : 0;
    group.errors += Number.isFinite(errors) && errors > 0 ? errors : 0;
  }

  return groups;
}

// UUID untuk URL langganan: hanya dipakai kalau SEMUA domain worker itu tercatat di panel dengan
// UUID yang sama. Kalau ada yang tidak diketahui atau berbeda, kembalikan string kosong supaya LB
// memakai UUID acak seperti sebelumnya (jangan menebak).
export function subUrlUuid(domains, workers) {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const list = (Array.isArray(domains) ? domains : []).map((d) => String(d || "").trim().toLowerCase()).filter(Boolean);
  if (list.length === 0 || !Array.isArray(workers)) return "";

  const found = new Set();
  for (const host of list) {
    const worker = workers.find((w) => w && typeof w.host === "string" && w.host.trim().toLowerCase() === host);
    const uuid = worker && typeof worker.uuid === "string" ? worker.uuid.trim() : "";
    if (!uuidRe.test(uuid)) return "";
    found.add(uuid.toLowerCase());
  }
  return found.size === 1 ? [...found][0] : "";
}

// Kredensial Cloudflare: API Token (awalan `cfut_`) tidak butuh email, Global API Key butuh.
// Cerminan fungsi yang sama di functions/api/lib/cf-auth.js (sisi server) — disalin ke berkas murni
// ini supaya panel di browser bisa memutuskan tanpa memuat berkas Functions.
export function cfSecretNeedsEmail(secret) {
  return !/^cfut_/i.test(typeof secret === "string" ? secret.trim() : "");
}

// --- Validasi isian form worker (halaman Workers) ----------------------------
// Pola domain yang sama dipakai form tambah worker (atribut `pattern` di workers.html): huruf
// kecil/angka/titik/strip, diawali & diakhiri huruf/angka.
const WORKER_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
// UUID v4 penuh. Nilainya masuk keadaan worker sebagai UUID_ALLOWLIST template, jadi bukan
// sembarang UUID: versi 4 + varian 8/9/a/b (UUID acak versi lain tidak pernah dibuat panel).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Account ID Cloudflare: 32 karakter hex tanpa strip.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
// Token langganan: 16 byte = 32 karakter hex.
const SUB_TOKEN_RE = /^[0-9a-f]{32}$/;

// hostFromInput membersihkan isian domain seperti form tambah worker: buang skema, lalu apa pun
// setelah `/`, `?`, `:`, atau `#`, dan huruf kecil.
export function hostFromInput(value) {
  return String(value ?? "").trim().replace(/^https?:\/\//i, "").replace(/[/?:#].*$/, "").toLowerCase();
}

// parseWorkerEdit memvalidasi isian form worker (tambah MAUPUN edit) dan mengembalikan nilai yang
// sudah dinormalkan:
//   { ok: true, worker: { name, host, type, uuid?, vpn_domains?, accountId? } }
//   { ok: false, error: "<alasan>" }
// Kolom opsional HANYA muncul di hasil kalau terisi: `undefined` berarti app.js menghapus kolom
// itu dari state (mis. worker VPN tidak menyimpan vpn_domains) — bukan menyisakan nilai lama.
export function parseWorkerEdit(values) {
  const source = values && typeof values === "object" ? values : {};

  const name = String(source.name ?? "").trim();
  if (!name) return { ok: false, error: "Nama Worker tidak boleh kosong." };

  const host = hostFromInput(source.host);
  if (!WORKER_HOST_RE.test(host) || host.includes("..")) {
    return { ok: false, error: "Domain Worker tidak valid (huruf kecil, angka, titik, strip)." };
  }

  const type = source.type === "load_balancer" ? "load_balancer" : "vpn";

  const rawUuid = String(source.uuid ?? "").trim();
  if (rawUuid && !UUID_V4_RE.test(rawUuid)) {
    return { ok: false, error: "UUID harus UUID v4 penuh (mis. 14df7aee-0416-45a8-a651-e69de188deca) atau dikosongkan." };
  }

  const rawAccount = String(source.accountId ?? "").trim();
  if (rawAccount && !ACCOUNT_ID_RE.test(rawAccount)) {
    return { ok: false, error: "Account ID Cloudflare harus 32 karakter hex (0-9, a-f) atau dikosongkan." };
  }

  const worker = { name: name, host: host, type: type };
  if (rawUuid) worker.uuid = rawUuid.toLowerCase();
  if (rawAccount) worker.accountId = rawAccount.toLowerCase();
  if (type === "load_balancer") {
    const domains = String(source.vpnDomains ?? "")
      .split(",")
      .map(hostFromInput)
      .filter(Boolean);
    if (domains.length) worker.vpn_domains = domains;
  }

  return { ok: true, worker: worker };
}

// parseSubToken memvalidasi token langganan yang diketik manusia (32 karakter hex). Ditulis huruf
// kecil supaya token yang sama tidak tersimpan dua bentuk di state.
export function parseSubToken(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SUB_TOKEN_RE.test(token)) return { ok: false, error: "Token langganan harus 32 karakter hex (0-9, a-f)." };
  return { ok: true, token: token };
}

// --- Simpanan kuota per akun -------------------------------------------------
// Kuota dimuat per akun (satu permintaan /api/workers-stats per akun), jadi hasilnya juga
// disimpan per akun: kunci `accountQuotaGate:<Account ID>`. Kunci lama `accountQuotaGate` (satu
// objek berisi semua akun) tetap dibaca lewat mergeQuotaSnapshots supaya data yang sudah
// tersimpan di browser tidak hilang.
export const ACCOUNT_QUOTA_SNAPSHOT_PREFIX = "accountQuotaGate:";
// Batas jumlah akun per pemuatan: jatah analitik Cloudflare 10 permintaan/10 menit, dan satu akun
// = satu permintaan.
export const QUOTA_MAX_ACCOUNTS = 3;

// quotaAccountTargets menentukan akun mana yang dimuat: Account ID unik dari state.workers, atau
// Account ID yang diisi di panel kalau belum ada worker yang menyimpannya. `limit` akun pertama
// dimuat, sisanya dilaporkan di `skipped` supaya UI bisa menyebutnya apa adanya — bukan
// diam-diam tidak dimuat.
export function quotaAccountTargets(workers, primaryAccountId, limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : QUOTA_MAX_ACCOUNTS;
  const own = [];
  for (const worker of Array.isArray(workers) ? workers : []) {
    const id = worker && typeof worker.accountId === "string" ? worker.accountId.trim() : "";
    if (id && !own.includes(id)) own.push(id);
  }
  const primary = typeof primaryAccountId === "string" ? primaryAccountId.trim() : "";
  const all = own.length ? own : primary ? [primary] : [];
  return { targets: all.slice(0, max), skipped: all.slice(max) };
}

// mergeQuotaSnapshots menggabungkan simpanan kuota (bentuk per akun maupun bentuk lama) menjadi
// satu snapshot untuk HARI INI. `dayKey` = tanggal UTC (YYYY-MM-DD) yang sama dengan jendela
// "hari ini" Cloudflare: simpanan hari lain dibuang, bukan dipakai (angka kemarin tidak boleh
// memblokir worker hari ini). Kembalian `null` kalau tidak ada simpanan hari ini.
export function mergeQuotaSnapshots(entries, dayKey) {
  const merged = {
    day: dayKey,
    savedAt: 0,
    quota: 0,
    threshold: ACCOUNT_QUOTA_THRESHOLD_DEFAULT,
    accounts: {},
    unattributed: [],
  };
  let found = false;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.day !== dayKey) continue;
    found = true;

    // Kuota/ambang diambil dari simpanan TERBARU saja: nilai yang sama untuk semua akun, dan yang
    // terbaru mencerminkan isian pengguna saat itu.
    if (Number.isFinite(entry.savedAt) && entry.savedAt > merged.savedAt) {
      merged.savedAt = entry.savedAt;
      if (Number(entry.quota) > 0) merged.quota = Number(entry.quota);
      merged.threshold = clampQuotaThreshold(entry.threshold);
    }

    // Bentuk per akun menyimpan satu akun di `account`; bentuk lama menyimpan peta `accounts`.
    const accounts = entry.accountId && entry.account ? { [entry.accountId]: entry.account } : entry.accounts;
    for (const [accountId, account] of Object.entries(accounts && typeof accounts === "object" ? accounts : {})) {
      if (account && typeof account === "object") merged.accounts[accountId] = account;
    }

    for (const name of Array.isArray(entry.unattributed) ? entry.unattributed : []) {
      if (!merged.unattributed.includes(name)) merged.unattributed.push(name);
    }
  }

  return found ? merged : null;
}
