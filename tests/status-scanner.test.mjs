// Uji bagian "kondisi scanner" halaman Status (frontend/status.js).
// Hanya fungsi murni + pagar sumber: tanpa DOM, tanpa jaringan, tanpa scanner sungguhan.
// Jalankan: node --test tests/status-scanner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  scannerFieldList,
  scannerHealthRows,
  scannerStatRows,
  scannerStatText,
} from "../frontend/status.js";

// Balasan sungguhan GET /api/health pada 2026-11-21.
const HEALTH = { ok: true, time: "2026-11-21T08:14:07.787522357Z" };

const rowOf = (rows, label) => rows.find((row) => row.label === label);

// --- pagar parse modul -------------------------------------------------------
test("status.js bisa diimpor di Node tanpa efek samping DOM (init dijaga)", async () => {
  const mod = await import("../frontend/status.js");
  assert.equal(typeof mod.scannerHealthRows, "function");
  assert.equal(typeof mod.scannerStatRows, "function");
});

// --- kondisi /api/health -----------------------------------------------------
test("scannerHealthRows: ok=true dan time tampil apa adanya", () => {
  const rows = scannerHealthRows(HEALTH);
  assert.equal(rowOf(rows, "ok").value, "true (hidup)");
  const time = rowOf(rows, "time").value;
  assert.notEqual(time, "-");
  assert.ok(time.includes("(waktu lokal)"), `jam lokal diharapkan, dapat: ${time}`);
  assert.equal(rowOf(rows, "bidang tersedia").value, "ok, time");
});

test("scannerHealthRows: ok=false berarti mati, bukan 0 atau kosong", () => {
  assert.equal(rowOf(scannerHealthRows({ ok: false }), "ok").value, "false (mati)");
});

test("scannerHealthRows: bidang versi hanya terisi kalau scanner mengirimnya", () => {
  assert.equal(rowOf(scannerHealthRows(HEALTH), "versi").value, "-", "tidak ada versi di balasan -> -");
  assert.equal(rowOf(scannerHealthRows({ ...HEALTH, version: "1.4.0" }), "versi").value, "1.4.0");
  assert.equal(rowOf(scannerHealthRows({ ...HEALTH, version: 7 }), "versi").value, "7");
});

test("scannerHealthRows: bidang baru yang dikirim scanner ikut terdaftar", () => {
  const rows = scannerHealthRows({ ok: true, time: HEALTH.time, uptime_s: 12, build: "abc" });
  assert.equal(rowOf(rows, "bidang tersedia").value, "ok, time, uptime_s, build");
});

test("scannerHealthRows: payload rusak/kosong jadi '-' semua, tidak melempar", () => {
  for (const payload of [null, undefined, "bukan objek", 42, []]) {
    const rows = scannerHealthRows(payload);
    assert.equal(rowOf(rows, "ok").value, "-", `ok untuk ${String(payload)}`);
    assert.equal(rowOf(rows, "time").value, "-");
    assert.equal(rowOf(rows, "bidang tersedia").value, "-");
    assert.ok(rows.length >= 4);
  }
});

test("scannerHealthRows: time yang tidak bisa dibaca -> '-'", () => {
  assert.equal(rowOf(scannerHealthRows({ ok: true, time: "bukan tanggal" }), "time").value, "-");
  assert.equal(rowOf(scannerHealthRows({ ok: true, time: 12345 }), "time").value, "-");
});

test("scannerFieldList: object kosong dan bukan object -> '-'", () => {
  assert.equal(scannerFieldList({}), "-");
  assert.equal(scannerFieldList(null), "-");
  assert.equal(scannerFieldList([1, 2]), "-");
  assert.equal(scannerFieldList({ a: 1, b: 2 }), "a, b");
});

// --- angka /api/stats (bentuk belum diketahui) -------------------------------
test("scannerStatText: angka, boolean, teks kosong, null", () => {
  assert.match(scannerStatText(1234), /^1[.,]?234$/);
  assert.equal(scannerStatText(0), "0");
  assert.equal(scannerStatText(Number.NaN), "-");
  assert.equal(scannerStatText(true), "true");
  assert.equal(scannerStatText(false), "false");
  assert.equal(scannerStatText(""), "-");
  assert.equal(scannerStatText(null), "-");
  assert.equal(scannerStatText(undefined), "-");
  assert.equal(scannerStatText({ a: 1 }), "-", "objek bukan daun; baris daunnya yang ditampilkan");
});

test("scannerStatRows: bidang datar tampil satu baris per bidang", () => {
  const rows = scannerStatRows({ candidates: 120, alive: 34, tls_ok: 12, last_scan: "2026-11-21T08:00:00Z", error: null });
  assert.deepEqual(rows.map((row) => row.label), ["candidates", "alive", "tls_ok", "last_scan", "error"]);
  assert.match(rowOf(rows, "candidates").value, /^120$/);
  assert.equal(rowOf(rows, "error").value, "-");
});

test("scannerStatRows: satu tingkat bersarang ditampilkan bertitik", () => {
  const rows = scannerStatRows({ pool: { candidates: 5, alive: 1 } });
  assert.deepEqual(rows.map((row) => row.label), ["pool.candidates", "pool.alive"]);
});

test("scannerStatRows: lebih dari dua tingkat diringkas jadi JSON pendek", () => {
  const rows = scannerStatRows({ a: { b: { c: 1, d: 2 } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "a.b");
  assert.equal(rows[0].value, '{"c":1,"d":2}');
});

test("scannerStatRows: array diteruskan dengan indeks", () => {
  const rows = scannerStatRows({ counts: [1, 2] });
  assert.deepEqual(rows.map((row) => row.label), ["counts[0]", "counts[1]"]);
  assert.deepEqual(rows.map((row) => row.value), ["1", "2"]);
});

test("scannerStatRows: kosong / tidak terbaca -> tanpa baris, bukan baris palsu", () => {
  assert.deepEqual(scannerStatRows(null), []);
  assert.deepEqual(scannerStatRows(undefined), []);
  assert.deepEqual(scannerStatRows({}), []);
  assert.deepEqual(scannerStatRows({ list: [] }), []);
});

test("scannerStatRows: nilai dikembalikan apa adanya, termasuk teks panjang", () => {
  const rows = scannerStatRows({ note: "kandidat dihitung dari pool" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "note");
  assert.equal(rows[0].value, "kandidat dihitung dari pool");
});

// --- pagar kredensial --------------------------------------------------------
test("token scanner: sessionStorage + header X-Api-Token, tidak pernah di localStorage/textContent", () => {
  const source = readFileSync(new URL("../frontend/status.js", import.meta.url), "utf8");
  assert.ok(source.includes("sessionStorage.setItem(SCANNER_TOKEN_KEY"), "token disimpan di sessionStorage");
  assert.ok(!/localStorage\.\w+\(\s*SCANNER_TOKEN_KEY/.test(source), "token tidak boleh masuk localStorage");
  assert.ok(source.includes('headers["x-api-token"] = token'), "token dikirim sebagai header X-Api-Token");
  assert.ok(
    !/textContent\s*=[^;]*\$\{[^}]*\btoken\b/i.test(source),
    "nilai token tidak boleh dicetak ke halaman"
  );
  assert.ok(/SCANNER_TIMEOUT_MS = 8000/.test(source) && /AbortController/.test(source), "permintaan scanner dibatasi waktu");
});
