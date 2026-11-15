// Alur login/daftar panel, dipisah dari app.js supaya urutan fallback-nya bisa diuji `node:test`
// tanpa DOM (tests/login-flow.test.mjs). Semua jaringan disuntik lewat `deps`, jadi tidak ada
// Supabase/DOM yang benar-benar disentuh saat diuji.
//
// URUTAN: RPC Supabase DULU, endpoint Pages Function (/api/login, /api/register) hanya cadangan
// kalau RPC belum ada (PGRST202/42883/42P01) atau jaringan gagal. Sebelum ini urutannya
// sebaliknya, dan itu dibalik karena KUOTA FUNCTIONS DIPAKAI BERSAMA /api/cf: limiter per-IP di
// route /api/login, /api/register, dan /api/cf dibukukan pada anggaran permintaan yang sama, jadi
// setiap login rutin yang lewat Function memakan jatah yang dibutuhkan deploy. Login tidak butuh
// apa pun dari Function — RPC verify_login (SECURITY DEFINER) sudah memverifikasi sandi sekaligus
// mengunci brute force per username — sementara RPC langsung ke PostgREST tidak menyentuh kuota
// Functions sama sekali. Function tetap tersedia sebagai cadangan supaya panel lama (SQL/RPC
// belum dijalankan) dan gangguan jaringan tidak mengunci orang di luar panel.
//
// Pesan terkunci (errcode 53400 dari verify_login, lihat sql/2026-11-14-login-lockout.sql) tetap
// dibedakan dari "sandi salah" dan TIDAK diturunkan ke Function: Function hanya membalas 502
// generik untuk exception itu, sehingga sisa waktu kuncinya hilang dari UI.

// Kode errcode yang dipakai verify_login saat akun sedang terkunci (configuration_limit_exceeded).
export const LOCKED_ERROR_CODE = "53400";

// Kode yang berarti "fungsi/tabel belum ada di database": panel harus memakai jalur berikutnya,
// bukan menganggap kredensial salah.
const MISSING_CODES = ["PGRST202", "42883", "42P01", "404"];

const INVALID_CREDENTIALS = "Username atau sandi salah.";

// rpcMissing: error dari supabase-js/PostgREST yang berarti RPC-nya belum ada di server.
export function rpcMissing(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || "");
  return MISSING_CODES.includes(code) || /could not find the function|does not exist/i.test(message);
}

export function rpcErrorMessage(error) {
  return String((error && error.message) || "tidak diketahui");
}

// throttleMessage menerjemahkan balasan endpoint yang kena limiter (429).
export function throttleMessage(data) {
  return (data && data.error) || "Terlalu banyak percobaan. Coba lagi nanti.";
}

// loginLockedMessage: pesan kunci akun, atau string kosong kalau error ini bukan kunci.
// Pesannya diambil apa adanya dari server karena di dalamnya ada sisa detik kunci.
export function loginLockedMessage(error) {
  if (!error) return "";
  const code = String(error.code || "");
  const message = String(error.message || "");
  if (code === LOCKED_ERROR_CODE) return message || "Terlalu banyak percobaan login gagal. Coba lagi nanti.";
  if (/terlalu banyak percobaan login gagal/i.test(message)) return message;
  return "";
}

// callRpc menyamakan bentuk kegagalan: supabase-js melempar untuk gangguan jaringan, sedangkan
// balasan PostgREST datang sebagai `error`. Pemanggil cukup menangani satu bentuk.
async function callRpc(deps, name, args) {
  try {
    const result = await deps.rpc(name, args);
    if (!result || typeof result !== "object") {
      return { data: null, error: { message: "balasan RPC tidak dikenal" } };
    }
    return { data: result.data ?? null, error: result.error || null };
  } catch (error) {
    return { data: null, error: { message: rpcErrorMessage(error) } };
  }
}

// loginWithFallback -> salah satu dari:
//   { status: "ok", user: { username, role } }
//   { status: "invalid",  message }        sandi/username salah
//   { status: "locked",   message }        akun terkunci (errcode 53400)
//   { status: "throttled", message }       endpoint Function kena limiter per IP
//   { status: "bad-request", message }
//   { status: "legacy" }                   RPC belum ada: panel memakai cara lama (baca users_custom)
//   { status: "error",    message }
export async function loginWithFallback(credentials, deps) {
  const username = String((credentials && credentials.username) || "");
  const password = String((credentials && credentials.password) || "");

  // 1. RPC verify_login: memverifikasi sandi dan menegakkan kunci per username.
  const viaRpc = await callRpc(deps, "verify_login", { p_username: username, p_password: password });
  if (!viaRpc.error) {
    const row = Array.isArray(viaRpc.data) ? viaRpc.data[0] : viaRpc.data;
    if (!row || !row.username) return { status: "invalid", message: INVALID_CREDENTIALS };
    return { status: "ok", user: { username: row.username, role: row.role || "user" } };
  }

  const locked = loginLockedMessage(viaRpc.error);
  if (locked) return { status: "locked", message: locked };

  // 2. Endpoint Function: cadangan untuk RPC yang belum ada / tidak terjangkau.
  const endpoint = await deps.postJson("/api/login", { username, password });
  if (endpoint && endpoint.ok && endpoint.data && endpoint.data.username) {
    return { status: "ok", user: { username: endpoint.data.username, role: endpoint.data.role || "user" } };
  }
  if (endpoint && endpoint.status === 401) return { status: "invalid", message: INVALID_CREDENTIALS };
  if (endpoint && endpoint.status === 429) return { status: "throttled", message: throttleMessage(endpoint.data) };
  if (endpoint && endpoint.status === 400) {
    return { status: "bad-request", message: (endpoint.data && endpoint.data.error) || "Isian login tidak valid." };
  }

  // 3. RPC-nya memang tidak ada (dan Function juga tidak melayani) => jalur lama.
  if (rpcMissing(viaRpc.error)) return { status: "legacy" };
  return { status: "error", message: "Error DB: " + rpcErrorMessage(viaRpc.error) };
}

// registerWithFallback memakai bentuk hasil yang sama dengan login. register_user hanya membuat
// role "user" (tidak bisa membuat admin), dan kehadirannya di RPC lebih dulu berarti pendaftaran
// tidak lagi melewati limiter per IP milik /api/register — itu konsekuensi urutan baru dan
// dicatat sebagai risiko; Function tetap dipanggil kalau RPC tidak ada.
export async function registerWithFallback(credentials, deps) {
  const username = String((credentials && credentials.username) || "");
  const password = String((credentials && credentials.password) || "");

  // 1. RPC register_user.
  const viaRpc = await callRpc(deps, "register_user", { p_username: username, p_password: password });
  if (!viaRpc.error) {
    if (viaRpc.data === false) return { status: "exists", message: "Username sudah terdaftar." };
    return { status: "ok", user: { username, role: "user" } };
  }

  // 2. Endpoint Function sebagai cadangan.
  const endpoint = await deps.postJson("/api/register", { username, password });
  if (endpoint && endpoint.ok && endpoint.data && endpoint.data.username) {
    return { status: "ok", user: { username: endpoint.data.username, role: "user" } };
  }
  if (endpoint && endpoint.status === 409) return { status: "exists", message: "Username sudah terdaftar." };
  if (endpoint && endpoint.status === 429) return { status: "throttled", message: throttleMessage(endpoint.data) };
  if (endpoint && endpoint.status === 400) {
    return { status: "bad-request", message: (endpoint.data && endpoint.data.error) || "Data tidak valid." };
  }

  // 3. Jalur lama hanya kalau RPC-nya memang belum ada; error lain dilaporkan apa adanya supaya
  // gangguan database tidak diam-diam berubah jadi "akun dibuat" palsu.
  if (rpcMissing(viaRpc.error)) return { status: "legacy" };
  return { status: "error", message: "Gagal buat akun: " + rpcErrorMessage(viaRpc.error) };
}
