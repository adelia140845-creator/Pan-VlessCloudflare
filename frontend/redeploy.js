// Logika murni untuk halaman Workers/Deploy: tombol "Deploy ulang semua Worker tersimpan"
// (halaman Deploy), helper token langganan Load Balancer yang dipakai jalur deploy tunggal dan
// tampilan URL langganan, riwayat pemeriksaan /health (uptime) yang ditampilkan di kartu worker,
// dan validasi isian form worker. Dipisah dari app.js supaya bisa diuji `node:test` tanpa DOM,
// Jaringan, maupun Cloudflare.

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

// Nama otomatis baris batch tanpa kolom nama: `akun 1`, `akun 2`, ... Nomor lanjutan dihitung dari
// nama berformat sama yang sudah ada; nama lain (mis. "VPN SG 1", "akun 9 cadangan", "akun9") tidak
// ikut dihitung. Spasi antar kata boleh lebih dari satu, huruf besar/kecil tidak dibedakan.
const AKUN_NAME_RE = /^akun\s+(\d+)$/i;
function akunNumber(name) {
  const match = AKUN_NAME_RE.exec(String(name ?? "").trim());
  return match ? Number(match[1]) : 0;
}

// parseWorkerBatch membaca teks banyak worker sekaligus (satu worker per baris) untuk halaman
// Workers. Aturannya sengaja sama dengan form tambah satu worker di atas, hanya bentuk masukannya
// yang berbeda:
//   `nama, host, jenis[, domains][, uuid][, accountId]` — koma, kolom kosong = tidak diisi.
//   - baris kosong dan baris berawalan `#` dilewati tanpa dilaporkan (komentar);
//   - baris satu kolom = DOMAIN saja: worker VPN tanpa nama, tanpa jenis (`vpn3.user.workers.dev`);
//   - `jenis`: vpn, lb, load_balancer, load-balancer (kosong / tidak dikenal = VPN, sama seperti
//     parseWorkerEdit yang hanya mengenal "load_balancer" sebagai LB);
//   - `domains` dipisah spasi dan hanya disimpan untuk Load Balancer (VPN tidak menyimpannya);
//   - validasi memakai aturan yang sama dengan parseWorkerEdit (pola host, UUID v4, Account ID);
//   - nama kosong -> nama otomatis `akun 1`, `akun 2`, ... (lihat AKUN_NAME_RE): nomornya
//     MELANJUTKAN nomor terbesar yang sudah ada di state + nama `akun N` eksplisit di batch yang
//     sama, jadi tempelan kedua tidak bentrok dengan yang pertama. Nama lain (mis. "VPN SG 1" atau
//     "akun 9 cadangan") tidak memengaruhi penomoran.
// `existingHosts` adalah daftar worker yang sudah ada: tiap entri boleh berupa host (teks) atau
// objek worker (dipakai `host` dan `name`-nya, mis. state.workers apa adanya).
// Hasil: { workers: [{ name, host, type, uuid?, accountId?, vpn_domains? }], skipped: [{ line, reason }],
//   errors: [{ line, reason }] } — `skipped` = baris benar tapi tidak perlu ditambahkan (host sudah
//   ada), `errors` = baris tidak sah. Nomor baris dihitung dari 1 seperti di textarea.
export function parseWorkerBatch(text, existingHosts) {
  const existing = (Array.isArray(existingHosts) ? existingHosts : []).map((entry) =>
    typeof entry === "string"
      ? { host: entry, name: "" }
      : { host: entry && entry.host, name: entry && entry.name }
  );
  const takenHosts = new Set(existing.map((entry) => hostFromInput(entry.host)).filter(Boolean));
  let akunCounter = 0;
  for (const entry of existing) akunCounter = Math.max(akunCounter, akunNumber(entry.name));

  const workers = [];
  const skipped = [];
  const errors = [];

  String(text ?? "").split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const row = raw.trim();
    if (!row || row.startsWith("#")) return;

    // Satu kolom = domain saja, jadi kolom pertama diperlakukan sebagai host (bukan nama).
    const columns = row.split(",").map((column) => column.trim());
    const [nameRaw = "", hostRaw = "", typeRaw = "", domainsRaw = "", uuidRaw = "", accountRaw = ""] =
      columns.length === 1 ? ["", columns[0]] : columns;

    const host = hostFromInput(hostRaw);
    if (!WORKER_HOST_RE.test(host) || host.includes("..")) {
      errors.push({ line: line, reason: "host tidak sah" });
      return;
    }
    if (takenHosts.has(host)) {
      skipped.push({ line: line, reason: "host sudah terdaftar" });
      return;
    }

    const uuid = uuidRaw.toLowerCase();
    if (uuid && !UUID_V4_RE.test(uuid)) {
      errors.push({ line: line, reason: "UUID bukan v4" });
      return;
    }
    const accountId = accountRaw.toLowerCase();
    if (accountId && !ACCOUNT_ID_RE.test(accountId)) {
      errors.push({ line: line, reason: "Account ID bukan 32 hex" });
      return;
    }

    let name = nameRaw;
    if (name) akunCounter = Math.max(akunCounter, akunNumber(name));
    else name = `akun ${akunCounter += 1}`;

    const worker = { name: name, host: host, type: /^(lb|load[_-]?balancer)$/i.test(typeRaw) ? "load_balancer" : "vpn" };
    if (uuid) worker.uuid = uuid;
    if (accountId) worker.accountId = accountId;
    if (worker.type === "load_balancer") {
      const domains = domainsRaw.split(/\s+/).map(hostFromInput).filter(Boolean);
      if (domains.length) worker.vpn_domains = domains;
    }

    takenHosts.add(host);
    workers.push(worker);
  });

  return { workers: workers, skipped: skipped, errors: errors };
}

// parseSubToken memvalidasi token langganan yang diketik manusia (32 karakter hex). Ditulis huruf
// kecil supaya token yang sama tidak tersimpan dua bentuk di state.
export function parseSubToken(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SUB_TOKEN_RE.test(token)) return { ok: false, error: "Token langganan harus 32 karakter hex (0-9, a-f)." };
  return { ok: true, token: token };
}
