// Uji penyusun binding env untuk jalur upload CLI (functions/api/lib/deploy-bindings.js).
// Tanpa jaringan, tanpa Cloudflare: nilai env dioper sebagai argumen.
// Jalankan: node --test tests/deploy-bindings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  relayBindings,
  subToken,
  subTokenBindings,
  workerBindings,
} from "../functions/api/lib/deploy-bindings.js";

const RELAY_ENV = {
  RELAY_SERVER_UDP: "relay.example.com",
  RELAY_SERVER_PORT: "7301",
  RELAY_SERVER_TLS: "tls",
  RELAY_SECRET: "rahasia-relay",
};

test("relayBindings kosong kalau RELAY_SERVER_UDP tidak diisi", () => {
  assert.deepEqual(relayBindings(), []);
  assert.deepEqual(relayBindings({}), []);
  assert.deepEqual(relayBindings({ RELAY_SERVER_UDP: "   " }), []);
});

test("relayBindings memakai RELAY_SERVER_PORT bawaan 7300 dan membuang binding kosong", () => {
  const bindings = relayBindings({ RELAY_SERVER_UDP: " relay.example.com ", RELAY_SECRET: " s " });

  assert.deepEqual(bindings, [
    { type: "plain_text", name: "RELAY_SERVER_UDP", text: "relay.example.com" },
    { type: "plain_text", name: "RELAY_SERVER_PORT", text: "7300" },
    { type: "plain_text", name: "RELAY_SECRET", text: "s" },
  ]);
});

test("relayBindings menolak RELAY_SERVER_UDP tanpa RELAY_SECRET", () => {
  assert.throws(() => relayBindings({ RELAY_SERVER_UDP: "relay.example.com" }), /RELAY_SECRET kosong/);
});

test("subToken membaca env apa adanya dan tidak pernah punya nilai bawaan", () => {
  assert.equal(subToken({}), "");
  assert.equal(subToken(), "");
  assert.equal(subToken({ SUB_TOKEN: "  " }), "");
  assert.equal(subToken({ SUB_TOKEN: " abc123 " }), "abc123");
});

test("subTokenBindings hanya untuk Load Balancer", () => {
  assert.deepEqual(subTokenBindings("vpn", { SUB_TOKEN: "abc123" }), []);
  assert.deepEqual(subTokenBindings("load_balancer", { SUB_TOKEN: "abc123" }), [
    { type: "plain_text", name: "SUB_TOKEN", text: "abc123" },
  ]);
});

test("subTokenBindings kosong kalau SUB_TOKEN tidak diisi (LB tetap terbuka)", () => {
  assert.deepEqual(subTokenBindings("load_balancer", {}), []);
  assert.deepEqual(subTokenBindings("load_balancer", { SUB_TOKEN: "   " }), []);
  assert.deepEqual(subTokenBindings("load_balancer"), []);
});

test("workerBindings: LB tanpa SUB_TOKEN hanya membawa binding relay", () => {
  assert.deepEqual(workerBindings("load_balancer", RELAY_ENV), relayBindings(RELAY_ENV));
  assert.equal(workerBindings("load_balancer", RELAY_ENV).some((b) => b.name === "SUB_TOKEN"), false);
});

test("workerBindings: LB dengan SUB_TOKEN membawa relay lalu SUB_TOKEN", () => {
  const bindings = workerBindings("load_balancer", { ...RELAY_ENV, SUB_TOKEN: "tok-32" });

  assert.deepEqual(bindings.map((b) => b.name), [
    "RELAY_SERVER_UDP",
    "RELAY_SERVER_PORT",
    "RELAY_SERVER_TLS",
    "RELAY_SECRET",
    "SUB_TOKEN",
  ]);
  assert.deepEqual(bindings.at(-1), { type: "plain_text", name: "SUB_TOKEN", text: "tok-32" });
  assert.equal(bindings.every((b) => b.type === "plain_text"), true);
});

test("workerBindings: SUB_TOKEN tidak pernah menempel ke Worker VPN", () => {
  const bindings = workerBindings("vpn", { SUB_TOKEN: "tok-32" });
  assert.deepEqual(bindings, []);
  assert.deepEqual(workerBindings("vpn", { ...RELAY_ENV, SUB_TOKEN: "tok-32" }).map((b) => b.name), [
    "RELAY_SERVER_UDP",
    "RELAY_SERVER_PORT",
    "RELAY_SERVER_TLS",
    "RELAY_SECRET",
  ]);
});
