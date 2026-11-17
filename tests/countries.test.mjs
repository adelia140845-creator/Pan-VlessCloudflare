// Uji daftar negara untuk pemilih filter Generator: ISO lengkap + kode dari pool, unik dan urut.
import test from "node:test";
import assert from "node:assert/strict";
import { COUNTRY_CODES, countryOptionList } from "../frontend/countries.js";

test("ISO 3166-1 lengkap: >200 kode, semuanya 2 huruf besar dan unik", () => {
  assert.ok(COUNTRY_CODES.length > 200, "jumlah kode: " + COUNTRY_CODES.length);
  assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length, "tidak ada duplikat");
  for (const code of COUNTRY_CODES) assert.match(code, /^[A-Z]{2}$/);
  for (const code of ["ID", "SG", "US", "DE", "JP", "MY"]) assert.ok(COUNTRY_CODES.includes(code), code + " harus ada");
});

test("countryOptionList: gabungan ISO + kode pool, unik, urut abjad", () => {
  const list = countryOptionList(["id", " sg ", "ZZ", "??", "", null, 42]);
  assert.ok(list.includes("ID") && list.includes("SG"), "kode pool ikut (huruf kecil dipetakan ke besar)");
  assert.ok(list.includes("ZZ"), "kode tak dikenal dari pool tetap tersedia");
  assert.equal(list.includes("??"), false, "label kosong tidak jadi opsi");
  assert.equal(new Set(list).size, list.length);
  assert.deepEqual(list, [...list].sort());
});

test("countryOptionList: masukan kosong/bukan array tetap memberi daftar ISO", () => {
  assert.equal(countryOptionList(undefined).length, COUNTRY_CODES.length);
  assert.equal(countryOptionList("ID").length, COUNTRY_CODES.length, "string bukan daftar kode");
});
