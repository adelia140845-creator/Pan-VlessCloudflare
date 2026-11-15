// Uji helper QR panel (frontend/qr.js): pemilihan sumber QR murni, tanpa DOM dan tanpa jaringan.
// Jalankan: node --test tests/qr.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureQrLib, firstConfigUri, qrTargets, renderQrInto } from "../frontend/qr.js";

const CONFIG = "vless://14df7aee-0416-45a8-a651-e69de188deca@sg.workers.dev:443?encryption=none&security=tls&type=ws&path=%2F#SG";
const SUB_URL = "https://lb.workers.dev/api/v1/sub?format=raw&limit=20&t=Rahasia123";

test("config saja: satu target berlabel Config dengan teks config apa adanya", () => {
  assert.deepEqual(qrTargets(CONFIG, ""), [{ kind: "config", label: "Config", text: CONFIG }]);
  assert.deepEqual(qrTargets(CONFIG, undefined), [{ kind: "config", label: "Config", text: CONFIG }]);
});

test("subscription saja: satu target berlabel URL Langganan", () => {
  assert.deepEqual(qrTargets("", SUB_URL), [{ kind: "subscription", label: "URL Langganan", text: SUB_URL }]);
});

test("keduanya: config dulu, lalu URL langganan, keduanya berlabel", () => {
  const targets = qrTargets(`${CONFIG}\n`, SUB_URL);
  assert.deepEqual(targets.map((t) => t.kind), ["config", "subscription"]);
  assert.deepEqual(targets.map((t) => t.label), ["Config", "URL Langganan"]);
  assert.equal(targets[0].text, CONFIG);
  assert.equal(targets[1].text, SUB_URL);
});

test("teks kosong: tidak ada target sama sekali", () => {
  assert.deepEqual(qrTargets("", ""), []);
  assert.deepEqual(qrTargets("   \n\t ", ""), []);
  assert.deepEqual(qrTargets(undefined, null), []);
  assert.deepEqual(qrTargets(null, undefined), []);
  assert.deepEqual(qrTargets(123, {}), []);
});

test("output raw banyak baris: hanya baris URI pertama yang jadi QR", () => {
  const text = `${CONFIG}\nvless://lain@jp.workers.dev:443?x=1#JP\n`;
  assert.deepEqual(qrTargets(text, ""), [{ kind: "config", label: "Config", text: CONFIG }]);
});

test("output bukan URI (V2Ray base64 / Clash YAML): tidak ada QR config, URL langganan tetap", () => {
  const base64 = "dmxlc3M6Ly8xMjM0QGhvc3Q6NDQz";
  assert.deepEqual(qrTargets(base64, ""), []);
  assert.deepEqual(qrTargets("proxies:\n  - name: SG\n    type: vless", SUB_URL), [
    { kind: "subscription", label: "URL Langganan", text: SUB_URL },
  ]);
});

test("dedup: URL langganan yang sama dengan config tidak diulang; spasi pinggir dibuang", () => {
  assert.deepEqual(qrTargets(CONFIG, CONFIG), [{ kind: "config", label: "Config", text: CONFIG }]);
  assert.deepEqual(qrTargets(CONFIG, `  ${CONFIG}  `), [{ kind: "config", label: "Config", text: CONFIG }]);
  assert.deepEqual(qrTargets(`  ${CONFIG}  `, SUB_URL)[0].text, CONFIG);
});

test("firstConfigUri mengenali skema vless/trojan/ss/vmess, bukan teks lain", () => {
  assert.equal(firstConfigUri(CONFIG), CONFIG);
  assert.equal(firstConfigUri("ss://YWVzOnh4@host:8388#SG"), "ss://YWVzOnh4@host:8388#SG");
  assert.equal(firstConfigUri("trojan://pass@host:443#SG"), "trojan://pass@host:443#SG");
  assert.equal(firstConfigUri("vmess://eyJ2IjoiMiJ9"), "vmess://eyJ2IjoiMiJ9");
  assert.equal(firstConfigUri("https://lb.workers.dev/api/v1/sub"), "");
  assert.equal(firstConfigUri(""), "");
  assert.equal(firstConfigUri(undefined), "");
});

test("tanpa DOM: pemuatan lib vendor ditolak dengan pesan jelas, bukan TypeError", async () => {
  await assert.rejects(ensureQrLib(), /hanya bisa dimuat di browser/);
});

test("renderQrInto menolak input tak terpakai sebelum menyentuh lib", async () => {
  await assert.rejects(renderQrInto(null, CONFIG), /Elemen QR tidak tersedia/);
  await assert.rejects(renderQrInto({}, "   "), /Tidak ada teks untuk dibuat QR/);
});

test("qr.js tanpa BOM dan masih modul yang bisa di-parse", async () => {
  const bytes = readFileSync(new URL("../frontend/qr.js", import.meta.url));
  assert.notEqual(bytes.subarray(0, 3).toString("hex"), "efbbbf", "frontend/qr.js diawali BOM");
  const mod = await import("../frontend/qr.js");
  assert.equal(typeof mod.qrTargets, "function");
});

test("berkas vendor ada, berlisensi MIT, dan UMD (bukan ESM)", () => {
  const source = readFileSync(new URL("../frontend/vendor/qrcode.js", import.meta.url), "utf8");
  assert.match(source, /qrcode@1\.4\.4/);
  assert.match(source, /MIT/);
  assert.match(source, /g\.QRCode = f\(\)/, "berkas vendor bukan build browser UMD");
  assert.equal(/^\s*export\s/m.test(source.split("\n").slice(0, 30).join("\n")), false);
});
