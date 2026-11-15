# RUNBOOK operasional cfvpn-hub

Dokumen ini untuk operator (manusia) yang menjaga unit produksi panel **Pan-VlessCloudflare**.
Semua perintah dijalankan dari mesin operator kecuali ditulis lain. Bahasa sengaja padat: satu
langkah = satu perintah/periksa.

Cakupan fakta: repo `cfvpn-hub` (Pages + `cron-worker` + SQL) dan repo terpisah `Pan-ProxyScanner`
(Go, Debian). Angka yang tidak bisa dipastikan dari repo ditandai **[belum dipastikan]**.

---

## 1. Peta unit & siapa boleh menulis apa

| Unit | Letak / konfigurasi | Deploy | URL |
|---|---|---|---|
| Panel Pages `cfvpn-hub` (SPA + `functions/api/*`) | `frontend/`, `functions/`, `wrangler.toml` | `npm run deploy`, atau job `deploy` di CI (push ke `main` + secret `CLOUDFLARE_API_TOKEN`) | https://cfvpn-hub-9xy.pages.dev |
| Cron Worker `proxy-cron-worker` | `cron-worker/` (config sendiri, cron `*/10 * * * *`) | manual: `cd cron-worker && npm install && npx wrangler deploy` | https://proxy-cron-worker.adelia140845.workers.dev |
| Worker VPN / Load Balancer per user | template `frontend/source/panvlesscloudflare.js` dan `load-balancer.js` | tombol Deploy/Deploy ulang di panel (`POST /api/cf`), atau `node deploy-bulk.mjs` | `<nama>.<akun>.workers.dev` |
| Scanner Go `Pan-ProxyScanner` | Debian; biner `dist/panproxyscanner-linux-amd64`, website+API `:8787`, SQLite `proxies.db`, `systemd` unit `panproxyscanner.service` | rilis biner + `sudo systemctl restart panproxyscanner` | https://panproxyscanner.jhopan.my.id (`SCANNER_URL` di `frontend/app.js:13`) |
| Relay UDP (`proxy-relay/udp-relay.mjs`) | repo, tidak dipakai: `TIER_FREE = true` di template membuat binding `RELAY_SERVER_UDP` diabaikan | — | — |
| Supabase | project `lumbbmhhmkcnxunuryjr` (region `ap-southeast-1`) | migrasi di `sql/`, dijalankan manusia (lihat §5) | https://lumbbmhhmkcnxunuryjr.supabase.co |

### Matriks penulisan data

| Data | Penulis sah | Pembaca | Kunci |
|---|---|---|---|
| `proxy_pool` (verdict proxy) | scanner: `push`, `pull-verify` (verdict), `MarkDead`, `UpdateVerdict`; cron-worker: `tunnel_ok`/`tunnel_ms`/`tunnel_checked`/`is_active`/`last_checked`/`ping` | panel (generator, Proxy, Status), Load Balancer (`/api/v1/sub`) | tulis: `supabase_service_key` / secret `SUPABASE_SERVICE_KEY`; baca: anon |
| `proxy_pool` DELETE | scanner saja (`prune`, `pool-purge`) | — | service key (fail-closed: tanpa key tidak ada DELETE) |
| `deploy_log` | panel: INSERT anon (satu baris per deploy sukses); `deploy_log_trim` hanya `service_role` | panel lewat RPC `deploy_log_list` (verifikasi hash) | anon (INSERT), service_role (trim) |
| `users_custom`, `user_states` | hanya RPC `SECURITY DEFINER` (`verify_login`, `register_user`, `admin_action`, `get_state`, `save_state`, `whoami`) | idem | anon (EXECUTE RPC saja) |
| `login_attempts`, `request_limits` | hanya fungsi internal | tidak ada akses klien | — |

Aturan tetap: **panel tidak pernah menulis `proxy_pool`**; setelah `sql/2026-11-15-pool-write-lockdown.sql`
anon hanya punya SELECT, jadi tulisan dari anon gagal (bukan bug).

---

## 2. Jadwal

| Pekerjaan | Jadwal | Sumber |
|---|---|---|
| Pipeline penuh scanner: pull-verify → scrape semua sumber → verifikasi → push menyeluruh → prune baris mati → housekeeping (`deploy_log_trim` + backup `user_states`) | `08:00` `Asia/Makassar` (00:00 UTC), mode `daily`. Kalau server mati saat jadwal, pipeline jalan begitu service hidup (catch-up), kegagalan dijadwalkan ulang tiap 15 menit | `settings.json` scanner: `schedule_mode`, `daily_at`, `schedule_timezone`; kode: `internal/settings` + `internal/api/server.go` |
| Cek lokal scanner: refresh baris tersimpan + pass target negara + push **delta** (hanya yang berubah sejak `meta.last_push_at`), tanpa scrape baru | tiap 6 jam pada kelipatan 00/06/12/18 UTC = 08/14/20/02 WITA | `test_interval_hours = 6` (bawaan), `NextTestRun()` |
| Probe edge `proxy-cron-worker` | tiap 10 menit (`*/10`); 100 baris/siklus, 10 lane paralel, deadline 25 s → pool ~300 baris aktif tersapu penuh ~30 menit | `cron-worker/wrangler.toml`, `cron-worker/src/index.js` |
| CI `cfvpn-hub` | tiap push/PR ke `main`: job `check` (`npm test` + `node --check`), job `deploy` hanya push ke `main` | `.github/workflows/ci.yml` |

**[belum dipastikan]** Nilai aktual `daily_at` di host Debian tidak bisa dibaca dari mesin ini
(berkasnya `~/.panproxyscanner/settings.json` di host). Bawaan kode `schedule_mode=interval` /
`daily_at=05:30`; contoh `settings.json` mesin dev memakai `daily 08:00 Asia/Makassar`. Verifikasi
lewat `GET /api/pipeline` (field `config`).

---

## 3. Cara memeriksa sehat/tidak

### 3.1 Panel

```bash
curl -sL -o /dev/null -w "%{http_code}\n" https://cfvpn-hub-9xy.pages.dev/          # 200
curl -sL -o /dev/null -w "%{http_code}\n" https://cfvpn-hub-9xy.pages.dev/status    # 200 (halaman admin)
```

Halaman dirender dari service worker: setelah deploy, **hard refresh** dulu sebelum menyimpulkan
panel rusak. Halaman Status adalah admin-only dan membaca langsung PostgREST + `GET /status` cron.

### 3.2 Halaman Status (admin) — angka yang dibaca

| Slice | Arti | Normal | Mencurigakan |
|---|---|---|---|
| Aktif | `is_active = true` | ratusan baris, relatif stabil | turun >50% dalam sehari tanpa scanner yang menyalakan lagi |
| Terbukti edge | `tunnel_ok = true` | ada, dan naik mendekati Aktif | tetap 0 padahal cron jalan → cron tidak bisa menulis |
| Belum diprobe | `tunnel_ok = null` | kecil dan **tidak naik** | naik terus → probe tidak menulis (secret/schema/worker mati) |
| Mati di edge | `tunnel_ok = false` | wajar > 0 (terukur 42 dari 72 baris aktif pada 14 Nov) | naik cepat bersamaan Aktif turun tajam |
| TLS ok / Terbukti host | `tls_ok`, `tunnel_host_ok` (vantage host) | sebagian besar Aktif | jatuh mendekati 0 → scanner berhenti push bukti |
| Segar < 6 jam | `last_checked` < 6 jam | ≈ Aktif | jauh di bawah Aktif → tak ada yang memperbarui `last_checked` |

Alasan tiap slice gagal ditampilkan sebagai `-` + kode HTTP, bukan 0. `-` karena
"kolom tidak terbaca" = migrasi terkait belum dijalankan.

### 3.3 Cron Worker

```bash
curl -s https://proxy-cron-worker.adelia140845.workers.dev/status
```

Balasan `{ok, startedAt, finishedAt, rows, checked, tunnel, disabled, tunnelColumns, error, stats}`.

- Sehat: `ok:true`, `finishedAt` ≤ ~20 menit lalu, `error:null`, `checked > 0`, `tunnelColumns:true`,
  `rows` ≈ 100.
- Rusak: `finishedAt` basi (>30 menit padahal cron 10 menit), `error` terisi, `checked:0` dengan
  `rows>0`, `tunnelColumns:false` (kolom tunnel tidak ada → jalankan migrasi), `rows:0` padahal
  halaman Status menampilkan Aktif > 0 (baca gagal atau `is_active` semua false).
- `disabled` puluhan dalam satu siklus adalah normal — worker ini **hanya mematikan**; yang
  menyalakan kembali adalah scanner.

### 3.4 Scanner

```bash
curl -s http://127.0.0.1:8787/api/health                    # {"ok":true,"time":...}
curl -s -H "X-Api-Token: <token>" http://127.0.0.1:8787/api/pipeline    # status + tiap langkah
curl -s -H "X-Api-Token: <token>" http://127.0.0.1:8787/api/supabase/status
```

- `write_key` pada `/api/supabase/status`: `service_key` = benar; `anon_key` berarti
  `supabase_service_key` kosong dan tulis jatuh ke anon (setelah lockdown akan gagal).
- Langkah `housekeeping deploy_log` dan `backup state user_states` harus muncul pada pipeline harian;
  tidak muncul = biner scanner masih rilis lama.
- `GET /api/tunnel`: `public.ok` = jalur Cloudflare sampai ke panel.

### 3.5 Worker VPN / Load Balancer

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>.workers.dev/health   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>.workers.dev/myip     # 200
curl -s https://<lb>.workers.dev/health                                        # {"ok":true,"type":"load_balancer",...}
```

`/health` worker VPN bisa digerbang `HEALTH_TOKEN` (401 tanpa token); `/myip` selalu terbuka.
`/health` Load Balancer selalu terbuka. Badge versi di panel membandingkan `WORKER_VERSION` /
`LB_VERSION` dengan konstanta panel — "versi lain" berarti worker perlu deploy ulang.

---

## 4. Kode status per endpoint

### 4.1 `POST /api/cf` (deploy worker lewat panel)

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | `{success, host, subdomain}`; worker terpasang + subdomain aktif | — |
| 400 | Body kurang (`cfEmail`/`cfApiKey`/`accountId`/`scriptName`/`code`), `vars` tidak valid, atau Cloudflare menolak upload (balasan memuat `details`) | baca `error`/`details`; periksa nama script & isi template; template tanpa komentar (`stripComments`) |
| 403 | Origin tidak diizinkan (`ALLOWED_ORIGINS`) | pakai panel dari domain resmi |
| 429 | Rate limit per IP (bawaan 10 permintaan/600 s, atau batas global `bump_rate`) | tunggu `Retry-After`; jangan ulangi otomatis (loop redeploy berhenti di 429) |
| 405 | Bukan POST | — |
| 500 | Error tak terduga (mis. Cloudflare API gagal) | lihat pesan; cek kredensial Cloudflare user; ulangi sekali |

### 4.2 `POST /api/login`

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | `{success, username, role}` | — |
| 400 | Body bukan JSON / username-sandi kosong-tidak valid | perbaiki input |
| 401 | Username/sandi tidak cocok (atau terkunci — panel menampilkan pesan kunci) | tunggu 15 menit (berlipat 30/60) |
| 429 | Rate limit (10/600 s per IP + batas global) | tunggu `Retry-After` |
| 502 | `verify_login` gagal di server (Supabase/PostgREST error) | cek project Supabase & RPC `verify_login` ada |
| 503 | RPC `verify_login` belum ada → jalankan `sql/2026-11-14-auth-hardening.sql` (+ `login-lockout`) | panel otomatis memakai jalur lama sampai SQL dijalankan |
| 405 | Bukan POST | — |

### 4.3 `POST /api/register`

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | User dibuat dengan role `user` | — |
| 400 | Input tidak valid | perbaiki input |
| 409 | Username sudah dipakai | pilih nama lain |
| 429 | Rate limit (5/600 s per IP + global) | tunggu `Retry-After` |
| 502 | `register_user` gagal di server | cek Supabase/RPC |
| 503 | RPC `register_user` belum ada | jalankan `sql/2026-11-14-auth-hardening.sql` |
| 405 | Bukan POST | — |

### 4.4 `POST /api/workers-stats`

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | Angka `workersInvocationsAdaptive` | — |
| 400 | Data kurang / `scriptName` tidak valid / balasan Cloudflare tanpa data | cek isian & nama script |
| 403 | Origin ditolak, **atau** token Cloudflare kurang izin `Account Analytics: Read` | buat token dengan izin itu, atau pakai kredensial user yang punya izin |
| 429 | Rate limit per IP / global | tunggu `Retry-After` |
| 502 | Cloudflare 5xx | ulangi nanti |
| 405 | Bukan POST | — |

### 4.5 `POST {SCANNER_URL}/api/pool-purge` (tombol "bersihkan baris mati")

Body `{username, hash}` sesi panel. Scanner memverifikasi lewat RPC `whoami` (harus `admin`) lalu
menghapus `proxy_pool?is_active=eq.false` dengan service key-nya sendiri.

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | `{success:true, deleted:N}` | — |
| 400 | Body bukan JSON / `username`/`hash` kosong | login ulang di panel, ulangi |
| 401 | Hash sesi salah / user tidak ada | login ulang |
| 403 | Bukan admin | minta admin |
| 405 | Bukan POST | — |
| 409 | RPC `whoami` belum ada | jalankan `sql/2026-11-14-login-lockout.sql` |
| 429 | Limiter 6 permintaan/10 menit per IP | tunggu `Retry-After` |
| 502 | `whoami` error lain, atau DELETE ditolak Supabase | cek status Supabase & izin `service_role` |
| 503 | `supabase_service_key` (atau URL/key) belum diset di scanner | isi service_role key di halaman Supabase scanner, lalu ulangi |

### 4.6 Prune scanner (`POST /api/supabase/prune?days=7&limit=2000`)

| Kode | Arti | Tindakan pertama |
|---|---|---|
| 200 | `{deleted, older_than_days, kandidat_sebelumnya, note}` | `deleted:0` + ada kandidat → key bukan service_role / policy DELETE hilang, atau `limit` habis (ulangi sampai 0) |
| 200 + `note` "butuh supabase_service_key" | service key kosong; **tidak ada** request DELETE dikirim | isi `supabase_service_key`, ulangi |
| 400 | URL/key Supabase belum diisi | isi di halaman Supabase scanner |
| 409 | Sinkronisasi lain sedang berjalan | tunggu selesai |
| 502 | DELETE gagal | cek error; pastikan migrasi prune sudah dijalankan |

### 4.7 Cron Worker

| Endpoint | Kode | Arti | Tindakan |
|---|---|---|---|
| `GET /status` | 200 | snapshot siklus terakhir (`no-store`) | lihat §3.3 |
| `GET /trigger` | 200 | siklus baru dimulai di latar belakang | baca hasil di `/status` |
| `GET /trigger` | 429 | siklus masih berjalan **atau** jeda <60 s sejak selesai | tunggu; jangan paksa berulang |

Catatan: `/trigger` menulis ke `proxy_pool` **produksi** (bisa mematikan baris), dan `wrangler dev`
di `cron-worker/` juga menembak project nyata.

---

## 5. Migrasi SQL

Semua migrasi dijalankan **manusia**, bukan agent. Jalur utama:

```bash
npx supabase@latest db query --remote=lumbbmhhmkcnxunuryjr -f sql/<berkas>.sql --yes
```

Atau tempel isi berkas di Supabase SQL Editor. Aturan wajib: uji berkas di Postgres lokal dulu
(kelas kesalahan yang pernah lolos: `drop policy if exists ... for insert ...` bukan sintaks sah).

### 5.1 Urutan aman

1. **Kolom bukti** (kode tahan kolom hilang, aman kapan saja):
   `2026-11-14-proxy-tunnel-columns.sql` → `2026-11-14-proxy-evidence-columns.sql` →
   `2026-11-14-tunnel-host-columns.sql` → `2026-11-14-pool-prune-index.sql`.
2. **Data fix sekali jalan** (opsional, setelah kolom tunnel ada): `2026-11-14-pool-recover-verified.sql`
   (`is_active=true` untuk baris `tunnel_ok is true`).
3. **Auth** — **deploy panel lebih dulu**, baru SQL:
   `2026-11-14-auth-hardening.sql` → `2026-11-14-login-lockout.sql` (berkas ini juga mendefinisikan
   `whoami`; **jangan** menjalankan berkas lain yang mendefinisikan `whoami` sesudahnya) →
   `2026-11-14-ratelimit.sql` → `2026-11-14-state-hardening.sql`.
4. **Riwayat deploy**: `2026-11-15-deploy-log.sql` → `2026-11-15-deploy-log-trim.sql`.
5. **Kunci tulis pool** (urutan ketat):
   `2026-11-15-pool-prune-service-key.sql` (cabut DELETE anon) → pastikan scanner & cron-worker
   **sudah** memakai service key (`write_key=service_key`, secret `SUPABASE_SERVICE_KEY` terpasang)
   → baru `2026-11-15-pool-write-lockdown.sql` (anon hanya SELECT).
   Membalik urutan ini = push scanner dan probe edge berhenti bisa menulis.

Status per 15 Nov 2026 (menurut `AGENTS.md` §Hard Rules + catatan Testing & QA): semua migrasi
2026-11-14 sudah dijalankan, termasuk `2026-11-15-pool-prune-service-key.sql` dan
`2026-11-15-deploy-log.sql` (diverifikasi: SELECT anon ke `deploy_log` → 401). **[belum dipastikan]**
`2026-11-15-deploy-log-trim.sql` dan `2026-11-15-pool-write-lockdown.sql` — jalankan hanya setelah
rilis scanner/cron yang memakai service key benar-benar terpasang.

### 5.2 Rollback

| Migrasi | Rollback | Efek |
|---|---|---|
| `2026-11-14-auth-hardening.sql` | `2026-11-14-auth-rollback.sql` | drop RPC auth; anon boleh SELECT/INSERT/UPDATE/DELETE `users_custom` lagi (**hash sandi terbuka**) |
| `2026-11-14-login-lockout.sql` | `2026-11-14-login-lockout-rollback.sql` | `whoami`/`verify_login` tanpa kunci; drop `login_attempts` & helper |
| `2026-11-14-state-hardening.sql` | `2026-11-14-state-rollback.sql` | drop `get_state`/`save_state`; state user bisa dibaca/ditimpa anon |
| `2026-11-14-tunnel-host-columns.sql` | `2026-11-14-tunnel-host-columns-rollback.sql` | drop 3 kolom + index `tunnel_host_*` |
| `2026-11-15-deploy-log.sql` | `2026-11-15-deploy-log-rollback.sql` | drop RPC `deploy_log_list` + tabel `deploy_log` (riwayat hilang) |
| `2026-11-15-deploy-log-trim.sql` | `2026-11-15-deploy-log-trim-rollback.sql` | drop fungsi trim; baris yang sudah terhapus tidak kembali |
| `2026-11-15-pool-prune-service-key.sql` | `2026-11-15-pool-prune-service-key-rollback.sql` | kembalikan policy `for all` + grant DELETE anon |
| `2026-11-15-pool-write-lockdown.sql` | `2026-11-15-pool-write-lockdown-rollback.sql` | anon boleh INSERT/UPDATE pool lagi (hanya untuk diagnosis) |
| `2026-11-14-proxy-tunnel-columns.sql` | tidak ada berkas | manual: `drop index if exists public.proxy_pool_active_tunnel_idx; alter table public.proxy_pool drop column if exists tunnel_checked, drop column if exists tunnel_ms, drop column if exists tunnel_ok; notify pgrst,'reload schema';` |
| `2026-11-14-proxy-evidence-columns.sql` | tidak ada berkas | manual: drop index `proxy_pool_active_tls_idx` + kolom `tls_ok`/`alt_ok`/`exit_ip`. **Jangan** cabut policy SELECT/INSERT/UPDATE — policy itu dipakai semua kode |
| `2026-11-14-pool-prune-index.sql` | tidak ada berkas | manual: `drop index if exists public.proxy_pool_pick_idx; drop index if exists public.proxy_pool_active_check_idx;` (baris yang sudah dihapus tidak kembali) |
| `2026-11-14-ratelimit.sql` | tidak ada berkas | manual: `drop function if exists public.bump_rate(text,int,int); drop table if exists public.request_limits;` → limiter global mati (fail-open) |
| `2026-11-14-pool-recover-verified.sql` | tidak perlu | koreksi data sekali jalan; tidak ada rollback otomatis (jangan balik massal) |

---

## 6. Token & kredensial

| Kredensial | Lokasi | Dipakai oleh | Rotasi |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` (Pages: Edit) | GitHub Secrets repo `adelia140845-creator/Pan-VlessCloudflare` | job `deploy` CI | buat token baru → ganti secret → hapus token lama → `workflow_dispatch`/push |
| OAuth wrangler | `C:\Users\ACER\.wrangler\config\default.toml` (akun Adelia) | deploy manual Pages/cron | `npx wrangler login` |
| `CLOUDFLARE_ACCOUNT_ID` | `.github/workflows/ci.yml` (bukan rahasia) | CI | — |
| `SUPABASE_SERVICE_KEY` (service_role) | Cloudflare secret Cron Worker (`npx wrangler secret put`, dari `cron-worker/`) | tulisan `proxy_pool` cron | lihat 6.1 |
| `supabase_service_key` (service_role) | `~/.panproxyscanner/settings.json` (mode 0600) | tulis/prune/trim/backup scanner | lihat 6.1 |
| anon key (publik) | hardcode: `frontend/app.js:3`, `frontend/status.js`, `frontend/source/load-balancer.js:5-6`, `cron-worker/src/index.js`, `settings.json` scanner (`supabase_key`), `.env` (dokumentasi) | baca pool + auth klien | lihat 6.2 |
| Token API scanner (`api_token`) | `settings.json` scanner | klien mesin (`X-Api-Token`) | lihat 6.3 |
| Sandi admin scanner | `settings.json` (`admin_password_hash`, SHA-256) | login web scanner | ganti di Scheduler → Akun & API; sesi lama hidup sampai 24 jam |
| `SUB_TOKEN` per Load Balancer | `state.workers[].sub_token` (localStorage + `user_states`) | gerbang `/api/v1/sub` | tombol "Ganti token" **+ deploy ulang LB** (tautan lama hidup sampai redeploy) |
| UUID worker | `state.workers[].uuid` + binding `UUID_ALLOWLIST` | klien VLESS | deploy ulang dengan UUID baru + perbarui config klien |

### 6.1 Rotasi service_role (Supabase)

Service key **tidak pernah** dikembalikan API (hanya `supabase_service_key_set: true`).

1. Supabase Dashboard → Settings → API → `service_role` → roll/regenerate. Kunci lama langsung mati.
2. Scanner: halaman Supabase di `http://<host>:8787` → tempel key baru → simpan; atau edit
   `~/.panproxyscanner/settings.json` (`"supabase_service_key"`) lalu `sudo systemctl restart panproxyscanner`.
3. Cron Worker: `cd cron-worker && npx wrangler secret put SUPABASE_SERVICE_KEY` → tempel nilai.
   Verifikasi: `npx wrangler secret list` (nama saja), lalu `GET /trigger` dan `GET /status`.
4. Bukti: scanner `POST /api/supabase/test` → `ok:true`; pipeline berikutnya `write_key=service_key`;
   cron `/status` `checked>0` dan baris `tunnel_checked` di Supabase bergerak.
5. Tanpa secret di cron, worker menulis dengan anon key + `console.warn` sekali per isolate; setelah
   lockdown, tulisan anon gagal — jadi langkah 3 wajib.

### 6.2 Rotasi anon key (publik, tetap harus disebar)

1. Catat semua titik: `frontend/app.js`, `frontend/status.js`, `frontend/source/load-balancer.js`,
   `cron-worker/src/index.js` (hanya baca `proxy_pool`), `settings.json` scanner (`supabase_key`),
   `.env` (dokumentasi).
2. Regenerate anon key di dashboard; ganti kelima titik + `settings.json`; restart scanner.
3. Naikkan `CACHE_NAME` di `frontend/sw.js` (sekarang `cfvpn-hub-v20`) supaya aset tidak basi.
4. `npm run deploy` (atau merge ke `main`), lalu `cd cron-worker && npx wrangler deploy`.
5. **Deploy ulang setiap Load Balancer** (panel → Deploy ulang semua): anon key tersemat di
   `load-balancer.js`, jadi LB lama tetap memakai key mati sampai dideploy ulang.
6. Verifikasi: panel bisa login & Generator memuat pool; `/health` LB 200; `/api/v1/sub` menjawab.

### 6.3 Rotasi token API scanner

1. Scanner → Scheduler → Akun & API → isi token baru (disimpan di `settings.json`).
2. Perbarui setiap klien mesin yang memakai `X-Api-Token`/`?token=` (skrip, cron lokal).
3. Verifikasi `curl -H "X-Api-Token: <baru>" http://127.0.0.1:8787/api/stats` → 200; token lama 401.

---

## 7. Playbook insiden

### 7.1 Worker 500 permanen

Gejala: semua request ke `<worker>.workers.dev/*` (termasuk `/myip`, kode trivial) 500.

1. Konfirmasi: `curl -s -o /dev/null -w "%{http_code}" https://<worker>.workers.dev/myip`.
2. Deploy ulang dari panel (halaman Workers/Deploy). Kalau masih 500, ini kondisi yang pernah
   terjadi setelah `wrangler deploy` crash (`Assertion failed ... uv async.c`): **hapus lalu buat ulang**
   worker `DELETE /accounts/<acc>/workers/scripts/<name>` → unggah ulang (panel atau API) →
   `POST .../subdomain {"enabled":true}` (tanpa ini 404).
3. Pastikan kode dikirim **tanpa komentar** (`stripComments`); source berkomentar pernah membuat
   worker 500 permanen.

### 7.2 Kualitas pool turun

Gejala: klien gagal konek / banyak `Mati di edge`; Aktif turun.

1. Buka halaman Status admin. Catat Aktif / Terbukti edge / Belum diprobe / Mati di edge.
2. `GET /status` cron: kalau `error` terisi atau `checked:0`, perbaiki cron dulu (lihat §7.3 langkah 2-3
   untuk kolom tunnel / izin tulis).
3. Satu kali `GET /trigger` saja (429 = tunggu). Hasil dibaca di `/status`.
4. Scanner: `POST /api/supabase/pull-verify?limit=100&jobs=100` (verifikasi ulang baris lama),
   lalu `POST /api/supabase/prune?days=7` untuk membuang yang mati lama.
5. Panel: tombol "bersihkan baris mati" (`/api/pool-purge`) setelah verifikasi.
6. Jangan menyalakan baris manual: yang berhak menaikkan `is_active` hanya scanner (verifikasi
   mendalam). Kalau pool tetap kurus, cek sumber scanner (`GET /api/sources`; sumber kosong 3×
   dimatikan otomatis) dan batas `push_org_cap`/`push_country_cap`.

### 7.3 Scanner mati / tidak menulis

1. `sudo systemctl status panproxyscanner` → `journalctl -u panproxyscanner -n 200 --no-pager`.
2. `curl -s http://127.0.0.1:8787/api/health` (harus `{"ok":true}`); cek port 8787 tidak dipakai proses lain.
3. `GET /api/pipeline`: langkah gagal + catatan. `GET /api/supabase/status`: `write_key`, catatan
   sinkron terakhir (`supabase_service_key belum diset ...` = key kosong).
4. Restart: `sudo systemctl restart panproxyscanner`; kalau biner diperbarui, pastikan
   `dist/panproxyscanner-linux-amd64` yang terpasang.
5. Kalau host mati total: §7.4 dulu (akses), lalu pulihkan service scanner. Pipeline harian punya
   catch-up, jadi satu hari terlewat akan dikejar saat hidup.
6. Verifikasi pemulihan: `write_key=service_key`, langkah pipeline OK, halaman Status "Terbukti edge" naik.

### 7.4 Tunnel Debian mati (domain scanner tidak bisa diakses)

1. `sudo systemctl status cloudflared-panproxyscanner.service` (nama mengikuti tunnel; lihat
   `GET /api/tunnel` → `service.unit`).
2. `sudo systemctl restart cloudflared-panproxyscanner`; cek log `journalctl -u cloudflared-panproxyscanner -n 100`.
3. `GET /api/tunnel` → `public.ok` harus `true` (uji jalur publik ke `/api/health`); `Uji ulang` memaksa cek.
4. Sementara publik mati, panel tetap jalan tetapi tombol purge gagal (scanner tak terjangkau);
   akses scanner lewat SSH tunnel/LAN untuk pekerjaan darurat.

### 7.5 Deploy CI gagal

1. Buka Actions → run terbaru. Job `check` merah = kode: jalankan `npm test` + `node --check`
   lokal, perbaiki, push lagi.
2. Job `deploy` hijau tapi ada pesan "Secret CLOUDFLARE_API_TOKEN belum diset — deploy dilewati":
   pasang secret (izin *Cloudflare Pages: Edit*), lalu `workflow_dispatch`.
3. `deploy` merah di wrangler (`Authentication error [code: 10000]` dll): cek token/akun; deploy
   manual `npm run deploy` (akun Adelia) tidak butuh secret CI.
4. Setelah deploy sukses, hard refresh panel dan pastikan perubahan terlihat (service worker).

### 7.6 Purge / prune gagal: 503, 409, 429

| Gejala | Sebab | Tindakan |
|---|---|---|
| `pool-purge` 503 | `supabase_service_key` (atau URL/key) kosong di scanner | isi key service_role (bukan anon) di halaman Supabase scanner |
| `pool-purge` 409 | RPC `whoami` belum ada | jalankan `sql/2026-11-14-login-lockout.sql` |
| `pool-purge` 429 | 6 permintaan/10 menit per IP | tunggu `Retry-After`, jangan spam (endpoint ini oracle hash) |
| prune `deleted:0` + kandidat | key anon dipasang sebagai service key / policy DELETE hilang | pastikan service_role key + `sql/2026-11-15-pool-prune-service-key.sql` |
| prune 409 | sinkronisasi scanner lain berjalan | tunggu pipeline/manual sync selesai |
| prune 502 | DELETE ditolak Supabase | cek pesan error, izin `service_role` di `proxy_pool` |

---

## 8. Rutin mingguan / bulanan

### Mingguan (≤15 menit)

1. Halaman Status admin: catat Aktif, Terbukti edge, **Belum diprobe** (harus tidak naik), Segar <6 jam.
2. `GET /status` cron: `error:null`, `finishedAt` baru, `tunnelColumns:true`.
3. Scanner `GET /api/pipeline`: semua langkah OK; `GET /api/supabase/status`: `write_key=service_key`.
4. Retensi `deploy_log`: 
   ```bash
   curl -s -X POST "https://lumbbmhhmkcnxunuryjr.supabase.co/rest/v1/rpc/deploy_log_trim" \
     -H "apikey: <service_role>" -H "Authorization: Bearer <service_role>" \
     -H "Content-Type: application/json" -d '{"p_keep_days":30}'
   ```
   Balasan = jumlah baris terhapus (integer). Pipeline harian memanggil ini otomatis (best-effort,
   `p_keep_days` 30); 401/403 = bukan service key. Rollback: `sql/2026-11-15-deploy-log-trim-rollback.sql`.
5. Backup state: pastikan berkas harian ada, maksimal 14 berkas, terbaru ≤2 hari:
   ```bash
   ls -l <folder DB>/backups/
   curl -s -X POST http://127.0.0.1:8787/api/state-backup -H "X-Api-Token: <token>"
   ```
   `<folder DB>` = direktori `proxies.db` (cwd service; default `./backups`). Balasan
   `{ok, path, bytes, user_states, proxy_pool, generated_at, kept, removed}`; `kept` ≤ 14.
   Berkas **tidak** memuat sandi/hash (hanya `state_data`: daftar worker, uuid, domain LB) — tetap
   perlakukan sebagai rahasia. Restore tidak otomatis: ambil `state_data` dari berkas, tulis lewat
   RPC/service_role secara manual per username, dan jangan pernah mengembalikan hash sandi.
6. `npx wrangler secret list` di `cron-worker/`: `SUPABASE_SERVICE_KEY` masih ada.

### Bulanan

1. Rotasi `CLOUDFLARE_API_TOKEN` CI (buat baru → ganti secret → hapus lama → jalankan pipeline).
2. Rotasi `service_role` (§6.1) — lakukan di jendela sepi; scanner & cron harus diperbarui dalam
   hitungan menit karena tidak ada masa transisi dua kunci.
3. Rotasi token API scanner (§6.3) dan sandi admin scanner bila ada pergantian orang.
4. Audit token LB: daftar LB + status token; rotasi yang tautannya pernah tersebar (Ganti token +
   deploy ulang).
5. Cek pertumbuhan `proxy_pool` vs `deploy_log`; jalankan prune scanner sekali (`days=7`) lalu
   `/api/pool-purge` bila baris mati menumpuk.
6. Uji pemulihan: buka satu berkas backup, pastikan bisa diparse dan **tidak** memuat hash sandi;
   uji satu worker dengan `FALLBACK_POOL=off` bila perlu mengukur proxy apa adanya.