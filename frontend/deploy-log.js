// Riwayat deploy (audit) — logika murni, tanpa DOM/Supabase, supaya bisa diuji `node:test`
// (tests/deploy-log.test.mjs). Tabelnya dibuat oleh sql/2026-11-15-deploy-log.sql dan bersifat
// opsional: panel harus tetap bekerja (dan tetap melaporkan deploy yang berhasil) di project yang
// belum menjalankan migrasi itu.
//
// Satu baris = satu deploy yang BERHASIL. Aksi:
//   "deploy"       — satu worker dari form halaman Deploy;
//   "redeploy-all" — batch "Deploy ulang semua Worker tersimpan" (satu baris per worker sukses).

export const DEPLOY_LOG_TABLE = "deploy_log";
export const DEPLOY_ACTIONS = ["deploy", "redeploy-all"];

// Pembacaan riwayat lewat RPC ber-hash, bukan select langsung: anon TIDAK punya hak SELECT pada
// tabelnya (lihat sql/2026-11-15-deploy-log.sql). RPC itu juga yang memutuskan admin (semua akun)
// vs user biasa (barisnya sendiri), jadi panel tidak perlu — dan tidak boleh — menyaring sendiri.
export const DEPLOY_LOG_RPC = "deploy_log_list";
export const DEPLOY_LOG_LIMIT = 20;

// Batas atas sama dengan penjagaan di dalam RPC (1..200).
const MAX_LIMIT = 200;

// Kode PostgREST/Postgres yang berarti tabel/fungsi belum ada: panel menampilkan catatan migrasi,
// bukan error.
const MISSING_CODES = ["PGRST202", "42883", "42P01", "404"];

// deployLogRpcArgs menyusun argumen panggilan RPC. Nama field HARUS sama dengan parameter
// public.deploy_log_list (p_username, p_hash, p_limit) atau PostgREST menolak panggilannya.
export function deployLogRpcArgs(username, hash, limit = DEPLOY_LOG_LIMIT) {
  const wanted = Number.isFinite(limit) ? Math.trunc(limit) : DEPLOY_LOG_LIMIT;
  return {
    p_username: typeof username === "string" ? username : "",
    p_hash: typeof hash === "string" ? hash : "",
    p_limit: Math.min(Math.max(wanted, 1), MAX_LIMIT),
  };
}

// deployLogHistoryState menerjemahkan hasil RPC jadi apa yang ditampilkan dashboard:
//   * galat "belum ada" (PGRST202/42P01) -> catatan migrasi, BUKAN error;
//   * galat lain (jaringan/izin)         -> pesan singkat, tanpa teks mentah server;
//   * sesi tanpa hash / hash tidak cocok -> RPC mengembalikan nol baris, dan itu ditampilkan
//     sebagai catatan biasa (bukan error), supaya sesi basi tidak tampak seperti panel rusak;
//   * baris ada                          -> jumlahnya dilaporkan apa adanya.
export function deployLogHistoryState({ rows, error, hasHash } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  if (error) {
    const notice = deployLogNotice(error);
    return { message: notice || "Riwayat deploy tidak bisa dimuat sekarang.", error: !notice, rows: [] };
  }

  if (!list.length) {
    return {
      message: hasHash
        ? "Belum ada riwayat deploy."
        : "Riwayat deploy tidak tampil: sesi ini belum membawa verifikasi sandi (login ulang dulu).",
      error: false,
      rows: [],
    };
  }

  return { message: `${list.length} deploy terakhir tercatat.`, error: false, rows: list };
}

// deployLogRow menyusun satu baris untuk tabel deploy_log. Nama field harus sama dengan kolom
// tabel (snake_case); `action` yang tidak dikenal dilempar sebagai error programmer, bukan ditulis
// sebagai baris audit yang salah.
export function deployLogRow(entry = {}) {
  const action = String(entry.action || "").trim();
  if (!DEPLOY_ACTIONS.includes(action)) {
    throw new Error(`action deploy_log tidak dikenal: "${action}"`);
  }

  const scriptName = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!scriptName) throw new Error("baris deploy_log butuh nama script worker");

  return {
    username: typeof entry.username === "string" ? entry.username.trim() : "",
    script_name: scriptName,
    type: typeof entry.type === "string" ? entry.type.trim() : "",
    host: typeof entry.host === "string" ? entry.host.trim() : "",
    action,
  };
}

// deployLogRows menyusun baris untuk beberapa worker sekaligus (dipakai batch redeploy-all).
// Entri tanpa nama script dilewati — sama seperti redeployPlan, worker tanpa nama tidak pernah
// dikirim ke /api/cf, jadi tidak boleh muncul di riwayat.
export function deployLogRows(username, action, entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .filter((entry) => entry && typeof entry.name === "string" && entry.name.trim())
    .map((entry) => deployLogRow({ username, action, name: entry.name, type: entry.type, host: entry.host }));
}

// deployLogMissing: true kalau error ini berarti tabel/relasi (atau RPC pembacanya) belum ada di
// database. PGRST202 = fungsi PostgREST tidak ketemu, 42P01 = relasinya, 42883 = fungsinya.
export function deployLogMissing(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || "");
  return MISSING_CODES.includes(code) || /does not exist|could not find the table/i.test(message);
}

// deployLogNotice: catatan ramah untuk tabel yang belum ada (string kosong = bukan kasus migrasi,
// pemanggil memakai pesan error apa adanya).
export function deployLogNotice(error) {
  return deployLogMissing(error)
    ? "Riwayat deploy belum aktif: migrasi sql/2026-11-15-deploy-log.sql belum dijalankan."
    : "";
}

// deployLogTime memformat created_at untuk daftar di dashboard, bentuk sama dengan tabel proxy
// (dd/mm hh:mm waktu lokal). Nilai yang tidak bisa dibaca jadi "—".
export function deployLogTime(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// deployLogLine menyusun satu baris tampilan: "15/11 14:20 · deploy · cfvpn-sg · vpn1.x.workers.dev · budi".
export function deployLogLine(row = {}) {
  const parts = [
    deployLogTime(row.created_at),
    String(row.action || ""),
    String(row.script_name || ""),
    String(row.host || ""),
  ];
  const username = String(row.username || "").trim();
  if (username) parts.push(username);
  return parts.filter(Boolean).join(" · ");
}
