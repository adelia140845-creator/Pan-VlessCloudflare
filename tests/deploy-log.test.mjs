// Uji riwayat deploy (frontend/deploy-log.js): pembuat baris log + penanganan "tabel belum ada".
// Jalankan: node --test tests/deploy-log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deployLogRow,
  deployLogRows,
  deployLogMissing,
  deployLogNotice,
  deployLogLine,
  deployLogTime,
  deployLogRpcArgs,
  deployLogHistoryState,
  DEPLOY_LOG_TABLE,
  DEPLOY_LOG_RPC,
  DEPLOY_LOG_LIMIT,
  DEPLOY_ACTIONS,
} from "../frontend/deploy-log.js";

// --- deployLogRow -----------------------------------------------------------

test("deployLogRow memakai nama kolom snake_case tabel deploy_log", () => {
  const row = deployLogRow({ username: "budi", name: "cfvpn-vpn-sg", type: "vpn", host: "vpn1.sg.workers.dev", action: "deploy" });

  assert.deepEqual(row, {
    username: "budi",
    script_name: "cfvpn-vpn-sg",
    type: "vpn",
    host: "vpn1.sg.workers.dev",
    action: "deploy",
  });
  assert.equal(DEPLOY_LOG_TABLE, "deploy_log");
  assert.deepEqual(DEPLOY_ACTIONS, ["deploy", "redeploy-all"]);
});

test("deployLogRow memangkas spasi dan memakai string kosong untuk kolom yang hilang", () => {
  const row = deployLogRow({ name: "  cfvpn-lb  ", action: "redeploy-all" });

  assert.equal(row.script_name, "cfvpn-lb");
  assert.equal(row.username, "");
  assert.equal(row.type, "");
  assert.equal(row.host, "");
});

test("deployLogRow melempar untuk aksi tak dikenal atau tanpa nama script", () => {
  assert.throws(() => deployLogRow({ name: "x", action: "hapus" }), /action deploy_log/);
  assert.throws(() => deployLogRow({ name: "x" }), /action deploy_log/);
  assert.throws(() => deployLogRow({ name: "   ", action: "deploy" }), /nama script/);
  assert.throws(() => deployLogRow({ action: "deploy" }), /nama script/);
});

// --- deployLogRows ----------------------------------------------------------

test("deployLogRows menulis satu baris per worker sukses dan melewati yang tanpa nama", () => {
  const rows = deployLogRows("budi", "redeploy-all", [
    { name: "cfvpn-vpn-sg", type: "vpn", host: "vpn1.workers.dev" },
    { name: "  ", type: "vpn", host: "tak-dipakai.workers.dev" },
    { name: "cfvpn-lb", type: "load_balancer", host: "lb.workers.dev" },
    null,
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.script_name), ["cfvpn-vpn-sg", "cfvpn-lb"]);
  assert.ok(rows.every((row) => row.action === "redeploy-all" && row.username === "budi"));
});

test("deployLogRows dengan daftar kosong / bukan array menghasilkan nol baris", () => {
  assert.deepEqual(deployLogRows("budi", "deploy", []), []);
  assert.deepEqual(deployLogRows("budi", "deploy", undefined), []);
});

test("deployLogRows tetap melempar untuk aksi yang tidak dikenal", () => {
  assert.throws(() => deployLogRows("budi", "deploy-semua", [{ name: "x" }]), /action deploy_log/);
});

// --- tabel belum ada --------------------------------------------------------

test("deployLogMissing mengenali kode & pesan 'tabel belum ada'", () => {
  assert.equal(deployLogMissing({ code: "PGRST202" }), true);
  assert.equal(deployLogMissing({ code: "42P01" }), true);
  assert.equal(deployLogMissing({ code: "42883" }), true);
  assert.equal(deployLogMissing({ code: "404" }), true);
  assert.equal(deployLogMissing({ message: 'relation "public.deploy_log" does not exist' }), true);
  assert.equal(deployLogMissing({ message: "Could not find the table 'public.deploy_log' in the schema cache" }), true);
});

test("deployLogMissing tidak mengklaim error lain sebagai 'belum ada'", () => {
  assert.equal(deployLogMissing({ code: "42501", message: "permission denied" }), false);
  assert.equal(deployLogMissing({ message: "JWT expired" }), false);
  assert.equal(deployLogMissing(null), false);
  assert.equal(deployLogMissing(undefined), false);
});

test("deployLogNotice menyebut migrasi hanya untuk tabel yang belum ada", () => {
  const notice = deployLogNotice({ code: "PGRST202" });

  assert.match(notice, /Riwayat deploy belum aktif/);
  assert.match(notice, /2026-11-15-deploy-log\.sql/);
  assert.equal(deployLogNotice({ code: "42501", message: "permission denied" }), "");
});

// --- pembacaan riwayat lewat RPC ber-hash -----------------------------------

test("deployLogRpcArgs memakai nama parameter deploy_log_list", () => {
  const args = deployLogRpcArgs("budi", "hash-uji");

  assert.deepEqual(args, { p_username: "budi", p_hash: "hash-uji", p_limit: 20 });
  assert.equal(DEPLOY_LOG_RPC, "deploy_log_list");
  assert.equal(DEPLOY_LOG_LIMIT, 20);
});

test("deployLogRpcArgs menjaga limit 1..200 dan menormalkan nilai aneh", () => {
  assert.equal(deployLogRpcArgs("budi", "h", 0).p_limit, 1);
  assert.equal(deployLogRpcArgs("budi", "h", 999).p_limit, 200);
  assert.equal(deployLogRpcArgs("budi", "h", 7.9).p_limit, 7);
  assert.equal(deployLogRpcArgs("budi", "h", Number.NaN).p_limit, 20);
  assert.equal(deployLogRpcArgs(undefined, null).p_username, "");
  assert.equal(deployLogRpcArgs(undefined, null).p_hash, "");
});

test("deployLogRpcArgs tidak pernah mengirim sandi — hanya hash sesi", () => {
  const args = deployLogRpcArgs("budi", "hash-uji");

  assert.deepEqual(Object.keys(args).sort(), ["p_hash", "p_limit", "p_username"]);
});

test("deployLogHistoryState: RPC belum ada = catatan migrasi, bukan error", () => {
  const state = deployLogHistoryState({ error: { code: "PGRST202", message: "Could not find the function public.deploy_log_list" }, hasHash: true });

  assert.equal(state.error, false);
  assert.match(state.message, /Riwayat deploy belum aktif/);
  assert.deepEqual(state.rows, []);
});

test("deployLogHistoryState: galat lain = pesan singkat tanpa teks mentah server", () => {
  const state = deployLogHistoryState({ error: { code: "42501", message: "permission denied for table deploy_log" }, hasHash: true });

  assert.equal(state.error, true);
  assert.equal(state.message, "Riwayat deploy tidak bisa dimuat sekarang.");
  assert.ok(!state.message.includes("permission denied"));
  assert.deepEqual(state.rows, []);
});

test("deployLogHistoryState: hash tidak cocok / sesi tanpa hash = nol baris tanpa error", () => {
  const noHash = deployLogHistoryState({ rows: [], hasHash: false });
  assert.equal(noHash.error, false);
  assert.match(noHash.message, /login ulang/);
  assert.deepEqual(noHash.rows, []);

  // Hash ada tapi tidak cocok: RPC mengembalikan nol baris, dan itu tampil sebagai catatan biasa.
  const emptyWithHash = deployLogHistoryState({ rows: [], hasHash: true });
  assert.equal(emptyWithHash.error, false);
  assert.equal(emptyWithHash.message, "Belum ada riwayat deploy.");
});

test("deployLogHistoryState: hasil bukan array diperlakukan sebagai kosong", () => {
  for (const rows of [undefined, null, "bukan array", { id: 1 }]) {
    const state = deployLogHistoryState({ rows, hasHash: true });
    assert.equal(state.error, false);
    assert.deepEqual(state.rows, []);
    assert.equal(state.message, "Belum ada riwayat deploy.");
  }
});

test("deployLogHistoryState: baris ada = jumlahnya dilaporkan dan barisnya diteruskan", () => {
  const rows = [{ id: 2, action: "redeploy-all", script_name: "cfvpn-lb" }, { id: 1, action: "deploy", script_name: "cfvpn-sg" }];
  const state = deployLogHistoryState({ rows, hasHash: true });

  assert.equal(state.error, false);
  assert.equal(state.message, "2 deploy terakhir tercatat.");
  assert.deepEqual(state.rows, rows);
});

// --- silang-periksa dengan migrasinya (statis, tidak dijalankan) --------------

test("migrasi deploy_log membuka baca lewat RPC ber-hash, bukan SELECT anon", () => {
  const sql = readFileSync(new URL("../sql/2026-11-15-deploy-log.sql", import.meta.url), "utf8");

  // RPC dengan tanda tangan yang dipakai panel, plus p_limit berdefault 20.
  assert.match(sql, /create or replace function public\.deploy_log_list\(p_username text, p_hash text, p_limit int default 20\)/);
  assert.match(sql, /returns table/);
  // Hash diverifikasi lewat users_custom, dan hasilnya kosong (bukan raise) saat tidak cocok.
  assert.match(sql, /from public\.users_custom u[\s\S]*?u\.password_hash = coalesce\(p_hash, ''\)/);
  assert.match(sql, /if v_role is null then\s*\n\s*return;/);
  // Cabang admin vs user biasa.
  assert.match(sql, /if v_role = 'admin' then/);
  assert.match(sql, /where l\.username = v_name/);
  // INSERT tetap ada, SELECT anon tidak.
  assert.match(sql, /grant insert on public\.deploy_log to anon, authenticated;/);
  assert.match(sql, /revoke select, update, delete on public\.deploy_log from anon, authenticated;/);
  assert.ok(!/create policy deploy_log_select_anon/.test(sql), "policy SELECT anon sudah tidak dibuat");
  assert.match(sql, /drop policy if exists deploy_log_select_anon/);
  // EXECUTE hanya untuk anon.
  assert.match(sql, /revoke all on function public\.deploy_log_list\(text, text, int\) from public, authenticated;/);
  assert.match(sql, /grant execute on function public\.deploy_log_list\(text, text, int\) to anon;/);
  assert.match(sql, /notify pgrst, 'reload schema';/);
});

test("rollback deploy_log ikut membuang RPC pembacanya", () => {
  const sql = readFileSync(new URL("../sql/2026-11-15-deploy-log-rollback.sql", import.meta.url), "utf8");

  assert.match(sql, /drop function if exists public\.deploy_log_list\(text, text, int\);/);
  assert.match(sql, /drop table if exists public\.deploy_log;/);
  assert.match(sql, /notify pgrst, 'reload schema';/);
});

// --- tampilan baris ---------------------------------------------------------

test("deployLogTime memformat waktu lokal dan memberi — untuk nilai rusak", () => {
  assert.match(deployLogTime("2026-11-15T10:20:30Z"), /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(deployLogTime("bukan tanggal"), "—");
  assert.equal(deployLogTime(null), "—");
  assert.equal(deployLogTime(undefined), "—");
});

test("deployLogLine menyusun satu baris: waktu · aksi · script · host · username", () => {
  const line = deployLogLine({
    created_at: "2026-11-15T10:20:30Z",
    action: "deploy",
    script_name: "cfvpn-vpn-sg",
    host: "vpn1.sg.workers.dev",
    username: "budi",
  });

  assert.match(line, /^\d{2}\/\d{2} \d{2}:\d{2} · deploy · cfvpn-vpn-sg · vpn1\.sg\.workers\.dev · budi$/);
});

test("deployLogLine tahan baris yang kolomnya kosong", () => {
  assert.equal(deployLogLine({ action: "deploy", script_name: "x" }), `${deployLogTime(undefined)} · deploy · x`);
  assert.equal(deployLogLine(), `${deployLogTime(undefined)}`);
});
