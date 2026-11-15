// Uji urutan fallback login/daftar (frontend/auth-flow.js): RPC Supabase DULU, endpoint Pages
// Function (/api/login, /api/register) hanya cadangan. `fetch` global di-stub supaya urutan
// panggilan jaringan bisa diperiksa apa adanya — tidak ada Supabase sungguhan yang dihubungi.
// Jalankan: node --test tests/login-flow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loginWithFallback, registerWithFallback, loginLockedMessage, rpcMissing, throttleMessage } from "../frontend/auth-flow.js";

const RPC_ORIGIN = "https://proyek-uji.supabase.co/rest/v1/rpc/";

function jsonReply(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

// stubFetch memasang pengganti fetch global selama satu uji. routes = daftar
// [potongan URL, (call) => Response]; rute yang bisa melempar dipakai untuk mensimulasi gangguan
// jaringan. URL tak dikenal ikut melempar supaya panggilan tak terduga terlihat sebagai gagal uji.
function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const call = { url: target, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    for (const [match, reply] of routes) {
      if (target.includes(match)) return reply(call);
    }
    throw new Error("fetch tak terduga: " + target);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// deps yang dipakai app.js: rpc meniru supabase-js (POST /rest/v1/rpc/<nama>, error PostgREST
// datang sebagai {code, message}), postJson meniru fungsi di app.js (null saat fetch melempar).
const deps = () => ({
  rpc: async (name, args) => {
    const res = await fetch(RPC_ORIGIN + name, { method: "POST", body: JSON.stringify(args) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok) return { data: body, error: null };
    return { data: null, error: { code: body && body.code, message: body && body.message } };
  },
  postJson: async (url, payload) => {
    try {
      const res = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, ok: res.ok, data };
    } catch {
      return null;
    }
  },
});

const LOGIN = { username: "budi", password: "rahasia" };
const REGISTER = { username: "siti", password: "rahasia" };

async function withFetch(routes, fn) {
  const stub = stubFetch(routes);
  try {
    return await fn(stub.calls);
  } finally {
    stub.restore();
  }
}

const RPC_LOGIN_OK = [RPC_ORIGIN + "verify_login", () => jsonReply({ username: "budi", role: "user" })];
const RPC_LOGIN_NULL = [RPC_ORIGIN + "verify_login", () => jsonReply(null) ];
const RPC_LOGIN_LOCKED = [RPC_ORIGIN + "verify_login", () => jsonReply({ code: "53400", message: "Terlalu banyak percobaan login gagal untuk akun ini. Coba lagi dalam 900 detik." }, 400)];
const RPC_LOGIN_MISSING = [RPC_ORIGIN + "verify_login", () => jsonReply({ code: "PGRST202", message: "Could not find the function public.verify_login" }, 404)];
const RPC_LOGIN_DOWN = [RPC_ORIGIN + "verify_login", () => { throw new Error("Failed to fetch"); }];
const FUNCTION_LOGIN_OK = ["/api/login", () => jsonReply({ success: true, username: "budi", role: "user" })];
const FUNCTION_LOGIN_503 = ["/api/login", () => jsonReply({ error: "Layanan login belum siap di server (RPC verify_login belum ada)." }, 503)];

// --- login: urutan RPC dulu -------------------------------------------------

test("login: sukses lewat RPC saja — tidak ada permintaan ke endpoint Function", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_OK, FUNCTION_LOGIN_OK], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.deepEqual(outcome, { status: "ok", user: { username: "budi", role: "user" } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(RPC_ORIGIN + "verify_login"));
  assert.deepEqual(calls[0].body, { p_username: "budi", p_password: "rahasia" });
});

test("login: RPC mengembalikan array tetap dibaca sebagai satu baris user", async () => {
  let outcome = null;
  const calls = await withFetch([[RPC_ORIGIN + "verify_login", () => jsonReply([{ username: "budi", role: "admin" }])]], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.user, { username: "budi", role: "admin" });
  assert.equal(calls.length, 1);
});

test("login: RPC mengembalikan null = sandi salah, Function tidak dipanggil", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_NULL, FUNCTION_LOGIN_OK], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.equal(outcome.status, "invalid");
  assert.match(outcome.message, /sandi salah/);
  assert.equal(calls.length, 1);
});

test("login: akun terkunci (53400) dibalas pesan kunci apa adanya dan Function tidak dipanggil", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_LOCKED, FUNCTION_LOGIN_OK], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.equal(outcome.status, "locked");
  assert.match(outcome.message, /900 detik/);
  assert.equal(calls.length, 1, "kunci tidak boleh diturunkan ke /api/login (pesannya hilang jadi 502 generik)");
});

test("login: RPC belum ada (PGRST202) baru memakai /api/login, urutannya RPC lalu Function", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_MISSING, FUNCTION_LOGIN_OK], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.deepEqual(outcome, { status: "ok", user: { username: "budi", role: "user" } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith(RPC_ORIGIN + "verify_login"));
  assert.equal(calls[1].url, "/api/login");
  assert.deepEqual(calls[1].body, { username: "budi", password: "rahasia" });
});

test("login: RPC tumbang karena jaringan (fetch melempar) — /api/login tetap dicoba", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_DOWN, FUNCTION_LOGIN_OK], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.equal(outcome.status, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/login");
});

test("login: RPC tumbang dan Function juga tumbang = status error berisi pesan RPC", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_DOWN, ["/api/login", () => { throw new Error("Failed to fetch"); }]], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /Error DB: Failed to fetch/);
  assert.equal(calls.length, 2);
});

test("login: RPC belum ada dan Function melaporkan 503 = jalur lama (legacy)", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_LOGIN_MISSING, FUNCTION_LOGIN_503], async (recorded) => {
    outcome = await loginWithFallback(LOGIN, deps());
    return recorded;
  });

  assert.deepEqual(outcome, { status: "legacy" });
  assert.equal(calls.length, 2);
});

test("login: Function 401 / 429 / 400 dipetakan ke invalid / throttled / bad-request", async () => {
  const cases = [
    [401, { error: "Username atau sandi salah." }, "invalid"],
    [429, { error: "Terlalu banyak percobaan. Coba lagi dalam 600 detik." }, "throttled"],
    [400, { error: "Isian tidak valid." }, "bad-request"],
  ];

  for (const [status, body, expected] of cases) {
    let outcome = null;
    await withFetch([RPC_LOGIN_MISSING, ["/api/login", () => jsonReply(body, status)]], async () => {
      outcome = await loginWithFallback(LOGIN, deps());
    });
    assert.equal(outcome.status, expected, `HTTP ${status}`);
    assert.ok(outcome.message);
  }

  // Error lain (mis. 500) bukan "RPC belum ada" => dilaporkan sebagai error RPC, bukan legacy.
  let outcome = null;
  await withFetch([[RPC_ORIGIN + "verify_login", () => jsonReply({ message: "gagal di server" }, 500)], ["/api/login", () => jsonReply({ error: "boom" }, 500)]], async () => {
    outcome = await loginWithFallback(LOGIN, deps());
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /gagal di server/);
});

// --- register: urutan RPC dulu ---------------------------------------------

const RPC_REGISTER_MISSING = [RPC_ORIGIN + "register_user", () => jsonReply({ code: "PGRST202", message: "Could not find the function public.register_user" }, 404)];
const FUNCTION_REGISTER_OK = ["/api/register", () => jsonReply({ success: true, username: "siti" })];

test("register: RPC register_user dipanggil lebih dulu; sukses RPC tidak menyentuh /api/register", async () => {
  let outcome = null;
  const calls = await withFetch([[RPC_ORIGIN + "register_user", () => jsonReply(true)], FUNCTION_REGISTER_OK], async (recorded) => {
    outcome = await registerWithFallback(REGISTER, deps());
    return recorded;
  });

  assert.deepEqual(outcome, { status: "ok", user: { username: "siti", role: "user" } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(RPC_ORIGIN + "register_user"));
  assert.deepEqual(calls[0].body, { p_username: "siti", p_password: "rahasia" });
});

test("register: RPC mengembalikan false = username sudah terdaftar (tanpa Function)", async () => {
  let outcome = null;
  const calls = await withFetch([[RPC_ORIGIN + "register_user", () => jsonReply(false)], FUNCTION_REGISTER_OK], async (recorded) => {
    outcome = await registerWithFallback(REGISTER, deps());
    return recorded;
  });

  assert.equal(outcome.status, "exists");
  assert.match(outcome.message, /sudah terdaftar/);
  assert.equal(calls.length, 1);
});

test("register: RPC belum ada baru memakai /api/register (RPC dulu, Function kedua)", async () => {
  let outcome = null;
  const calls = await withFetch([RPC_REGISTER_MISSING, FUNCTION_REGISTER_OK], async (recorded) => {
    outcome = await registerWithFallback(REGISTER, deps());
    return recorded;
  });

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.user, { username: "siti", role: "user" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith(RPC_ORIGIN + "register_user"));
  assert.equal(calls[1].url, "/api/register");
});

test("register: RPC belum ada dan Function 409 = username sudah terdaftar", async () => {
  let outcome = null;
  await withFetch([RPC_REGISTER_MISSING, ["/api/register", () => jsonReply({ error: "Username sudah terdaftar." }, 409)]], async () => {
    outcome = await registerWithFallback(REGISTER, deps());
  });

  assert.equal(outcome.status, "exists");
});

test("register: RPC belum ada dan Function 503 = jalur lama (legacy)", async () => {
  let outcome = null;
  await withFetch([RPC_REGISTER_MISSING, ["/api/register", () => jsonReply({ error: "belum siap" }, 503)]], async () => {
    outcome = await registerWithFallback(REGISTER, deps());
  });

  assert.deepEqual(outcome, { status: "legacy" });
});

test("register: RPC gagal (bukan 'belum ada') dan Function juga gagal = error RPC, bukan legacy", async () => {
  let outcome = null;
  await withFetch([[RPC_ORIGIN + "register_user", () => { throw new Error("Failed to fetch"); }], ["/api/register", () => { throw new Error("Failed to fetch"); }]], async () => {
    outcome = await registerWithFallback(REGISTER, deps());
  });

  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /Gagal buat akun: Failed to fetch/);
});

// --- helper -----------------------------------------------------------------

test("rpcMissing hanya mengenali error 'fungsi belum ada'", () => {
  assert.equal(rpcMissing({ code: "PGRST202" }), true);
  assert.equal(rpcMissing({ code: "42883" }), true);
  assert.equal(rpcMissing({ code: "42P01" }), true);
  assert.equal(rpcMissing({ code: "404" }), true);
  assert.equal(rpcMissing({ message: 'function public.verify_login does not exist' }), true);
  assert.equal(rpcMissing({ code: "53400", message: "terkunci" }), false);
  assert.equal(rpcMissing({ message: "Failed to fetch" }), false);
  assert.equal(rpcMissing(null), false);
});

test("loginLockedMessage membedakan kunci akun dari error lain", () => {
  assert.match(loginLockedMessage({ code: "53400", message: "Coba lagi dalam 900 detik." }), /900 detik/);
  assert.match(loginLockedMessage({ message: "Terlalu banyak percobaan login gagal untuk akun ini." }), /Terlalu banyak/);
  assert.equal(loginLockedMessage({ code: "PGRST202", message: "does not exist" }), "");
  assert.equal(loginLockedMessage(null), "");
});

test("throttleMessage memakai pesan server dan menyediakan cadangan", () => {
  assert.equal(throttleMessage({ error: "Terlalu banyak percobaan. Coba lagi dalam 600 detik." }), "Terlalu banyak percobaan. Coba lagi dalam 600 detik.");
  assert.equal(throttleMessage(null), "Terlalu banyak percobaan. Coba lagi nanti.");
});
