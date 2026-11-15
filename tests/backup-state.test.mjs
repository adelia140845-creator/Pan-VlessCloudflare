// Uji export/import state panel (frontend/backup.js) tanpa DOM, localStorage, atau jaringan.
// Jalankan: node --test tests/backup-state.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { serializeState, parseState, BACKUP_FORMAT, BACKUP_VERSION, WORKER_TYPES } from "../frontend/backup.js";

const worker = (over = {}) => ({ id: "w-1", name: "VPN SG 1", host: "vpn1.sg.workers.dev", type: "vpn", active: true, ...over });

// --- serializeState ---------------------------------------------------------

test("serializeState menulis berkas JSON rapi berisi metadata + state", () => {
  const text = serializeState(
    { generatedCount: 7, workers: [worker()] },
    { username: "budi", exportedAt: "2026-11-15T10:00:00.000Z" }
  );

  const payload = JSON.parse(text);
  assert.equal(payload.format, BACKUP_FORMAT);
  assert.equal(payload.version, BACKUP_VERSION);
  assert.equal(payload.exportedAt, "2026-11-15T10:00:00.000Z");
  assert.equal(payload.username, "budi");
  assert.equal(payload.workerCount, 1);
  assert.deepEqual(payload.state.workers, [worker()]);
  assert.equal(payload.state.generatedCount, 7);
  // Rapi dibaca manusia/di-diff: indentasi 2 spasi, bukan satu baris.
  assert.ok(text.includes("\n  \"format\""));
});

test("serializeState mengisi exportedAt sendiri dan tahan state kosong/aneh", () => {
  const payload = JSON.parse(serializeState(undefined));

  assert.equal(payload.workerCount, 0);
  assert.deepEqual(payload.state.workers, []);
  assert.equal(payload.state.generatedCount, 0);
  assert.equal(payload.username, "");
  assert.ok(!Number.isNaN(Date.parse(payload.exportedAt)));
});

test("hasil serializeState bisa dibaca ulang parseState tanpa berubah", () => {
  const state = { generatedCount: 3, workers: [worker(), worker({ id: "w-2", type: "load_balancer", host: "lb.workers.dev", active: false })] };
  const parsed = parseState(serializeState(state, { username: "budi" }));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.state, state);
  assert.equal(parsed.duplicates, 0);
});

// --- parseState: berkas valid ----------------------------------------------

test("parseState menerima berkas valid dan menormalkan field worker", () => {
  const text = JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    state: {
      generatedCount: 2,
      workers: [
        { id: "w-1", name: "  VPN SG 1  ", host: "vpn1.workers.dev", type: "vpn", active: true },
        { id: "w-2", name: "LB", host: "lb.workers.dev", type: "load_balancer" },
      ],
    },
  });

  const parsed = parseState(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.workers.length, 2);
  assert.equal(parsed.state.workers[0].name, "VPN SG 1");
  assert.equal(parsed.state.generatedCount, 2);
  // active yang tidak disebut dianggap aktif supaya import lama tidak mematikan semua kartu.
  assert.equal(parsed.state.workers[1].active, true);
  // Jenis yang dikenal saja (daftar dipakai bersama renderWorkers/redeployPlan).
  assert.deepEqual(WORKER_TYPES, ["vpn", "load_balancer"]);
});

test("parseState menerima state mentah tanpa pembungkus (backup versi lama)", () => {
  const parsed = parseState(JSON.stringify({ workers: [worker()] }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.workers.length, 1);
  assert.equal(parsed.state.generatedCount, 0);
});

test("parseState membawa field ekstra apa adanya (uuid, sub_token, kunci top-level lain)", () => {
  const text = JSON.stringify({
    state: {
      generatedCount: 1,
      pengaturanBaru: { tema: "gelap" },
      workers: [worker({ uuid: "1111-2222", sub_token: "abc123", catatan: "dibuat manual" })],
    },
  });

  const parsed = parseState(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.pengaturanBaru.tema, "gelap");
  assert.equal(parsed.state.workers[0].uuid, "1111-2222");
  assert.equal(parsed.state.workers[0].sub_token, "abc123");
  assert.equal(parsed.state.workers[0].catatan, "dibuat manual");
});

test("parseState memberi id baru untuk worker tanpa id (id dipakai sebagai kunci kartu)", () => {
  let seq = 0;
  const parsed = parseState(JSON.stringify({ workers: [{ name: "Tanpa id", host: "x.workers.dev", type: "vpn" }] }), {
    makeId: () => `baru-${(seq += 1)}`,
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.workers[0].id, "baru-1");
});

test("parseState membuang id duplikat: entri pertama menang, tidak mengubah urutan", () => {
  const parsed = parseState(
    JSON.stringify({
      workers: [
        worker({ id: "sama", name: "Pertama" }),
        worker({ id: "sama", name: "Kedua" }),
        worker({ id: "lain", name: "Ketiga" }),
      ],
    })
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.duplicates, 1);
  assert.deepEqual(parsed.state.workers.map((w) => w.name), ["Pertama", "Ketiga"]);
});

// --- parseState: berkas rusak ----------------------------------------------

test("parseState menolak teks kosong / bukan teks / bukan JSON", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}]) {
    const parsed = parseState(bad);
    assert.equal(parsed.ok, false, `seharusnya ditolak: ${String(bad)}`);
    assert.ok(parsed.error);
  }
  assert.match(parseState("{ bukan json").error, /JSON/);
});

test("parseState menolak JSON yang bukan objek state", () => {
  assert.match(parseState("[1,2,3]").error, /objek JSON/);
  assert.match(parseState("\"teks\"").error, /objek JSON/);
  assert.match(parseState("null").error, /objek JSON/);
});

test("parseState menolak state tanpa daftar workers", () => {
  assert.match(parseState(JSON.stringify({ generatedCount: 1 })).error, /workers/);
  assert.match(parseState(JSON.stringify({ state: { workers: "bukan array" } })).error, /workers/);
});

test("parseState menolak entri yang bukan objek, tanpa nama, atau berjenis tidak dikenal", () => {
  const cases = [
    { workers: ["bukan objek"] },
    { workers: [null] },
    { workers: [{ name: "   ", type: "vpn" }] },
    { workers: [{ type: "vpn" }] },
    { workers: [{ name: "X", type: "tier-prem" }] },
    { workers: [{ name: "X" }] },
  ];

  for (const payload of cases) {
    const parsed = parseState(JSON.stringify(payload));
    assert.equal(parsed.ok, false, `seharusnya ditolak: ${JSON.stringify(payload)}`);
  }

  assert.match(parseState(JSON.stringify({ workers: [{ name: "X", type: "tier-prem" }] })).error, /tier-prem/);
  assert.match(parseState(JSON.stringify({ workers: [worker(), { name: "" }] })).error, /Worker ke-2/);
});

test("berkas rusak tidak pernah menghasilkan state parsial", () => {
  const parsed = parseState(JSON.stringify({ workers: [worker(), { name: "rusak", type: "bukan-jenis" }] }));

  assert.equal(parsed.ok, false);
  assert.equal("state" in parsed, false);
});
