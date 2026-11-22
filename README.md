# Pan-VlessCloudflare

Panel manajemen Cloudflare VPN (VLESS-over-WebSocket). Nama lama: **CFVPN Hub** — repo, halaman, dan dokumen memakai nama baru ini; folder hasil clone boleh bernama apa saja.

Panel manajemen VPN Worker untuk Cloudflare. Kelola Worker, generate config VLESS/Trojan/Shadowsocks, dan kelola proxy pool dari satu tempat.

**Live:** [https://cfvpn-hub-9xy.pages.dev](https://cfvpn-hub-9xy.pages.dev)

## Aksi admin & edit worker (panel)

- Halaman **Admin**: tombol **Reset sandi** dan **Buka kunci** per user (butuh migrasi `sql/2026-11-21-admin-actions.sql`; sebelum dijalankan panel memberi tahu bahwa migrasinya belum ada).
- Halaman **Workers**: tombol **Edit** untuk mengubah nama/host/jenis/UUID/VPN domains/Account ID, dan **Tetapkan token** untuk LB (tanpa deploy ulang).

## Fitur

- **Dashboard** — statistik Worker aktif, config dibuat, proxy aktif
  - **Export/Import state** (berkas JSON berisi daftar Worker & jumlah config) dengan validasi ketat: duplikat dibuang, berkas rusak ditolak tanpa mengubah state
  - **Riwayat deploy**: 20 deploy terakhir (nama worker, jenis, host, aksi, waktu)
- **Workers** — kelola VPN Worker & Load Balancer (grup terpisah, toggle aktif/nonaktif)
  - **Uptime & versi**: badge `/health` per worker (status, waktu cek terakhir, latensi, uptime %, versi vs template), 20 sampel terakhir disimpan di browser
  - **Cek semua**: periksa semua worker aktif satu per satu dengan progres
  - **Ganti token** (Load Balancer): buat token langganan baru; tautan lama mati setelah deploy ulang
- **Generator** — buat config VPN (local generator atau subscription dari Load Balancer)
  - Filter proxy berdasarkan negara & penyedia
  - Pilih proxy spesifik atau acak
  - Output: Raw, V2Ray (Base64), Clash YAML, Sing-box JSON
  - **QR** untuk config `vless://` dan, di mode subscription, untuk URL langganan
  - Cache proxy 6 jam
- **Proxy Pool** — tambah proxy (cek aktif sebelum simpan), lihat tabel lengkap
- **Deploy** — deploy VPN Worker / Load Balancer langsung ke Cloudflare
  - Auto-save Worker ke dashboard setelah deploy
- **User Management** (admin only) — kelola user, tambah admin, hapus user
- **PWA** — install sebagai app, cache offline
- **Role system** — admin & user biasa

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript (ES Module, no framework)
- **Backend:** Cloudflare Pages Functions
- **Database:** Supabase (auth, proxy pool, user states)
- **Hosting:** Cloudflare Pages
- **PWA:** manifest.json + Service Worker

## Struktur Folder

```
Pan-VlessCloudflare/
├── frontend/              # Cloudflare Pages output
│   ├── admin.html         # User management (admin only)
│   ├── app.js             # Logic utama
│   ├── auth-flow.js       # Urutan login/daftar (RPC dulu, Function cadangan)
│   ├── backup.js          # Export/import state dashboard
│   ├── deploy-log.js      # Riwayat deploy (deploy_log)
│   ├── deploy.html        # Deploy worker
│   ├── generator.html     # Generator config
│   ├── index.html         # Dashboard
│   ├── landing.html       # Landing page publik
│   ├── login.html         # Login + Register (tab)
│   ├── manifest.json      # PWA manifest
│   ├── proxy.html         # Proxy pool
│   ├── qr.js              # QR generator config / URL langganan
│   ├── redeploy.js        # Logika batch redeploy + riwayat /health
│   ├── register.html      # Redirect ke login#register
│   ├── status.html        # Halaman Status (admin)
│   ├── status.js          # Data halaman Status
│   ├── style.css          # Style
│   ├── sw.js              # Service Worker
│   ├── vendor/qrcode.js   # Lib QR (qrcode@1.4.4, MIT, di-vendor lokal)
│   ├── workers.html       # Workers management
│   └── source/            # Source code Worker (di-fetch saat deploy)
│       ├── load-balancer.js
│       └── panvlesscloudflare.js
├── functions/             # Cloudflare Pages Functions
│   └── api/
│       ├── cf.js          # Deploy worker endpoint
│       ├── login.js       # Cadangan login (dipakai kalau RPC belum ada)
│       └── register.js    # Cadangan daftar
├── sql/                   # Migrasi manual (auth, kolom bukti, deploy_log)
├── cron-worker/           # Cron worker (proxy checker)
│   ├── src/index.js
│   ├── package.json
│   └── wrangler.toml
├── deploy-bulk.mjs        # Script menu deploy Worker batch (lokal)
├── workers.txt            # Input nama Worker, satu nama per baris
├── deployed.txt           # Output URL Worker online (dibuat script)
├── status.txt             # Output status Worker (dibuat script)
├── tests/                 # Test files
├── .env                   # Credentials lokal (jangan commit!)
├── .gitignore
├── package.json
└── wrangler.toml
```

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/adelia140845-creator/Pan-VlessCloudflare.git
cd Pan-VlessCloudflare
npm install
```

### 2. Environment Variables

Buat file `.env`:

```env
# Cloudflare
CLOUDFLARE_API_KEY=your_cf_api_key
CLOUDFLARE_EMAIL=your_email
CLOUDFLARE_ACCOUNT_ID=your_account_id

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

### 3. Supabase Database

Jalankan SQL ini di Supabase SQL Editor:

```sql
-- Tabel users
CREATE TABLE IF NOT EXISTS users_custom (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT DEFAULT 'user',
  telegram_chat_id TEXT
);

-- Tabel proxy pool
CREATE TABLE IF NOT EXISTS proxy_pool (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ip TEXT NOT NULL,
  port TEXT NOT NULL,
  country TEXT,
  org TEXT,
  is_active BOOLEAN DEFAULT true,
  last_checked TIMESTAMPTZ,
  ping INTEGER,
  -- bukti verifikasi dari aplikasi `proxy-scraping` (lihat catatan di bawah)
  tls_ok BOOLEAN NOT NULL DEFAULT false,
  alt_ok BOOLEAN NOT NULL DEFAULT false,
  exit_ip TEXT
);

-- Catatan `is_active`: hanya verifikasi mendalam (aplikasi `proxy-scraping`) yang boleh
-- menaikkannya. `cron-worker` hanya boleh mematikannya. Cek HTTP dangkal bisa lolos di proxy
-- yang tidak sanggup tunnel TLS 443, sedangkan panel memakai proxy untuk WebSocket VLESS di
-- 443 — hasilnya konfigurasi mati.
--
-- Skema resmi yang dipakai project aktif ada di `supabase/schema.sql`
-- (project `lumbbmhhmkcnxunuryjr`, org "Adelia Hub"; kolom bukti + policy RLS termasuk DELETE).

-- Tabel user states (workers, generated configs)
CREATE TABLE IF NOT EXISTS user_states (
  username TEXT REFERENCES users_custom(username),
  state_data JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Set user sebagai admin
UPDATE users_custom SET role = 'admin' WHERE username = 'your_username';
```

### 4. Run Local

```bash
npm run dev
```

Buka `http://localhost:8788`

### 5. Deploy

```bash
# Set env vars dulu
export CLOUDFLARE_API_KEY="your_key"
export CLOUDFLARE_EMAIL="your_email"
export CLOUDFLARE_ACCOUNT_ID="your_account_id"

# Deploy
npm run deploy
```

Deploy panel ada dua jalur. Manual: `npm run deploy`. Otomatis: job `deploy` di `.github/workflows/ci.yml` menjalankan `wrangler pages deploy` setelah unit test lolos, tetapi hanya aktif kalau kamu menambahkan secret `CLOUDFLARE_API_TOKEN` (izin Cloudflare Pages: Edit) di GitHub — tanpa itu job melewati deploy dengan pesan jelas. Integrasi Git bawaan Cloudflare Pages tidak dipakai karena project ini bertipe direct upload.

Catatan operasional: tombol **bersihkan baris mati** di halaman Proxy tidak lagi memakai Pages
Function. Panel memanggil scanner (`SCANNER_URL` di `app.js`, default
`https://panproxyscanner.jhopan.my.id/api/pool-purge`) yang memverifikasi sesi admin lewat RPC
`whoami` lalu menghapus dengan service key miliknya sendiri. Kalau tombol menjawab 503 berarti
`supabase_service_key` di scanner belum diisi; 409 berarti migrasi `sql/2026-11-14-login-lockout.sql`
belum dijalankan; 429 berarti limiter (6 permintaan / 10 menit per IP) sedang menahan.

Catatan keamanan: berkas di `frontend/source/` (template Worker VPN dan Load Balancer) **publik** — siapa pun bisa mengunduhnya. Itu tidak membocorkan rahasia: hanya ada **satu** template Worker VPN (`panvlesscloudflare.js`) dan seluruh isinya memang publik. Relay UDP tidak aktif di template yang dikirim (`TIER_FREE = true`), dan kalau nanti diaktifkan pengamannya adalah `RELAY_SECRET` di server relay, bukan kerahasiaan template. Kunci Supabase `service_role` tidak ada di frontend (hanya di Functions).

## Cron Worker (Proxy Checker)

Deploy cron worker terpisah untuk cek proxy tiap jam:

```bash
cd cron-worker
npm install
npx wrangler deploy
```

Set env vars di `cron-worker/wrangler.toml` atau Cloudflare dashboard.

### Verifikasi tunnel & kolom baru

Cron worker menembus setiap proxy secara nyata (HTTP CONNECT lalu SOCKS5 ke `example.com:80`) dan
menyimpan hasilnya di kolom baru. Jalankan dulu berkas ini di Supabase SQL Editor:

```
sql/2026-11-14-proxy-tunnel-columns.sql
```

Sebelum SQL dijalankan cron tetap jalan (hanya menulis kolom lama, satu peringatan per siklus).
Yang ditulis: `tunnel_ok` (`null` = belum pernah diperiksa, `false` = terbukti gagal), `tunnel_ms`,
`tunnel_checked`, dan `ping` (kini = waktu tunnel). **Verdict probe tunnel dipakai untuk
memeriksa/mematikan**: baris yang gagal dimatikan, sedangkan yang menyalakan kembali adalah
panproxyscanner (pipeline produksi). Sebelumnya penentu
adalah cek ringan 5 detik, dan itu salah dua arah — terukur 15 baris terbukti tembus justru
dimatikan, 7 baris aktif tapi terbukti mati.
Worker memakai rantai empat tingkat saat memilih proxy dari pool:
`tunnel_ok` (verdict edge) → `tls_ok` (bukti host TLS) → `tunnel_host_ok` (bukti tunnel dari host scanner) → ping. Baris dengan
`tunnel_ok = false` diletakkan paling belakang karena worker VLESS berjalan di edge, jadi vonis edge
yang menentukan — pengukuran 14 Nov menunjukkan 42 dari 72 baris aktif ber-`tls_ok = true` tapi
`tunnel_ok = false`.
Bukti dari mesin scanner dikirim terpisah sebagai `tunnel_host_ok` / `tunnel_host_ms` /
`tunnel_host_checked` (butuh `sql/2026-11-14-tunnel-host-columns.sql`); halaman Generator menandai
tiap baris dengan sumber buktinya (`✓ edge` / `✓ host` / `✗ mati di edge`) dan tidak pernah
menawarkan baris yang di edge terbukti mati.

Pipeline produksi untuk mengisi pool adalah **panproxyscanner** (jalan terjadwal di server, siklus 120 menit, verifikasi HTTP → TLS 443 → port non-standar). Panel dan worker menganggap `tls_ok = true` sebagai bukti setara `tunnel_ok`.

Scraper lokal di dalam repo ini sudah dihapus (15 Nov 2026): pipeline yang mengisi pool sekarang
hanya **panproxyscanner** di server (lihat bagian di atas), sedangkan penguji ulang dari sisi edge
dijalankan `proxy-cron-worker` dari `cron-worker/`. Untuk menguji satu alamat secara manual, pakai
`python tests/prod-proxy-check.py` atau `node tests/check-proxy.mjs`.

### Keamanan: auth server-side & rate limit

1. **Deploy panel dulu**, baru jalankan `sql/2026-11-14-auth-hardening.sql` di Supabase SQL Editor.
   Setelah itu kolom hash sandi tidak bisa dibaca dengan anon key dan pembuatan/pengubahan admin
   diverifikasi server (RPC `verify_login`, `register_user`, `admin_action`). Panel tetap bisa
   login sebelum SQL dijalankan karena jalur lama dipakai otomatis. **Status: kedua berkas SQL
   sudah dijalankan di proyek ini (2026-11-14); akun lama perlu login ulang sekali** supaya sesi
   membawa verifikasi untuk aksi admin.
5. `POST /api/login` dan `POST /api/register` (Pages Functions) membatasi percobaan per IP, lalu
   menaikkannya jadi batas **global** lewat `sql/2026-11-14-ratelimit.sql`. **Urutan pemakaiannya
   sekarang RPC dulu:** panel memanggil `verify_login`/`register_user` lebih dulu dan baru memakai
   `/api/login`/`/api/register` kalau RPC belum ada, jaringan gagal, atau server menjawab 503 —
   supaya kuota Functions tidak habis untuk login rutin. Konsekuensinya, pembatas per-IP itu tidak
   lagi berada di jalur login sehari-hari; pagar yang selalu berlaku adalah **kunci brute force
   per username** di database (5 gagal → 15 menit, berlipat 30/60 menit, dari
   `sql/2026-11-14-login-lockout.sql`), dan pesan sisa waktunya ditampilkan apa adanya.
6. State per user (`user_states`) hanya bisa dibaca/ditulis pemiliknya lewat RPC
   (`sql/2026-11-14-state-hardening.sql`), jadi sesi palsu di browser tidak bisa menimpa daftar
   worker orang lain. Batas 256 KB per user.
7. CI: `.github/workflows/ci.yml` menjalankan `npm test` dan
   `node --check` untuk semua berkas yang dikirim (harness smoke tidak, karena butuh jaringan).
2. `POST /api/cf` punya rate limit per IP (bawaan 10 permintaan / 600 detik). Atur lewat env
   `RATE_LIMIT` dan `RATE_WINDOW_SEC`. Batas ini per-colo dan best-effort, bukan kuota global.
3. Gerbang Origin opsional: isi env `ALLOWED_ORIGINS` (mis. `https://cfvpn-hub-9xy.pages.dev`,
   boleh pola `*.domain`) untuk menolak pemanggilan dari origin lain. Kosong = seperti sebelumnya.
4. Worker VPN bisa menutup `/health` dengan binding `HEALTH_TOKEN` (`?token=` atau header
   `x-health-token`); badge versi worker di dasbor berhenti bekerja kalau ini diaktifkan.
   `/health` **bukan hanya milik template VPN**: Load Balancer juga punya `GET /health` dan di sana
   endpoint itu selalu terbuka (tanpa token) plus CORS, membalas
   `{"ok":true,"type":"load_balancer","version":"..."}` — gerbang `SUB_TOKEN` hanya berlaku untuk
   `/api/v1/sub`. Itulah yang dipakai halaman Workers untuk memantau LB dan membandingkan versinya
   dengan template.

## Role System

| Role | Akses |
|------|-------|
| User | Dashboard, Workers, Generator, Proxy, Deploy Worker |
| Admin | Semua akses User + User Management, refresh cache, force cron |

## Deploy Worker (VPN/LB)

1. Buka halaman Deploy
2. Isi Cloudflare credentials
3. Pilih jenis: VPN Worker atau Load Balancer
4. Isi nama worker
5. Klik "Mulai Deploy"
6. Worker ter-deploy + otomatis masuk ke daftar Workers

**Satu versi worker untuk semua akun:** tidak ada lagi pilihan Free/Premium. Panel selalu memilih template `frontend/source/panvlesscloudflare.js` untuk VPN Worker (atau `load-balancer.js` untuk Load Balancer) sesuai jenis yang dipilih, dan itu berlaku sama untuk user maupun admin — jadi tidak ada field versi yang disembunyikan dan tidak ada fitur yang berbeda antar akun. Relay UDP nonaktif di template yang dikirim (`TIER_FREE = true`).

### Memilih proxy dari path (selector)

Path kedua URL WebSocket menentukan proxy mana yang dipakai worker:

| Path | Arti |
|---|---|
| `/<ip>-<port>` atau `/<ip>:<port>` | pakai proxy itu saja (seperti sebelumnya) |
| `/ALL`, `/ROTATE`, `/AUTO`, `/POOL` | worker memilih acak dari 6 proxy teratas pool |
| `/ID`, `/SG`, `/ID,SG`, `/US-ID` | hanya negara itu (kode 2 huruf), pilih acak dari teratas |

Enaknya: konfigurasi ber-selector tidak perlu diganti saat pool berubah, dan failover tetap
berlaku di atas pilihan itu.

Kalau memakai filter negara, worker **gagal-tertutup**: saat negara itu sedang tidak punya proxy
sehat, koneksi ditutup — bukan diam-diam keluar lewat proxy negara lain. Longgarkan dengan
beberapa negara (`/ID,SG`) atau pakai `/ALL` kalau negara keluar tidak penting. Halaman **Generator** punya centang **"Mode rotasi"**: filter negara
yang dipilih otomatis menjadi path (`/ID`, `/ID,SG`, atau `/ALL` kalau tanpa filter). Daftar negara
bisa dipilih lebih dari satu (Ctrl/Cmd) dan tiap pilihan menampilkan jumlah proxy segar; kalau
tidak ada satu pun proxy siap pakai, Generator memberi peringatan sebelum config dibuat.

### Kunci tautan langganan (Load Balancer)

LB yang dideploy dari panel mendapat token 32 karakter, dan URL langganan yang ditampilkan panel
selalu menyertakan `&t=<token>`. Kalau binding `SUB_TOKEN` sudah terpasang tetapi token tidak
dikirim (URL lama), LB menjawab 403. Mengganti token: klik **"Ganti token"** di kartu LB pada
halaman **Workers** (token baru dibuat dan disimpan), lalu deploy ulang LB-nya lewat halaman
**Deploy** — tautan lama tetap hidup sampai deploy ulang itu, karena token hanya terpasang saat
deploy. Isi pool untuk langganan di-cache 60 detik di sisi LB, jadi perubahan pool terlihat paling
lambat satu menit kemudian.

Worker VPN membalas `GET /health` (bisa digerbang dengan binding `HEALTH_TOKEN`), sedangkan LB
membalas endpoint yang sama **selalu terbuka tanpa token** dan mengirim CORS:
`{"ok":true,"type":"load_balancer","version":"2026-11-15a" (template VPN memakai `type:"vpn"` dan versinya sendiri)}`.
Gerbang `SUB_TOKEN` hanya menjaga `/api/v1/sub`, jadi memantau versi worker tidak mengharuskan
token langganan disimpan di mana pun. Bandingkan `version` dengan versi template di panel: angka
yang berbeda berarti LB masih memakai template lama dan perlu deploy ulang.

### Halaman Workers (uptime, token)

- **Badge kesehatan** tiap kartu worker mengambil `/health`: status, waktu cek terakhir, latensi,
  uptime %, dan versi template vs versi di panel. Riwayat disimpan di browser (20 sampel terakhir
  per worker, `localStorage["workerHealthCache"]`) — bukan di server, jadi hilang kalau data
  browser dibersihkan.
- **"Cek semua"** memeriksa semua worker aktif satu per satu dengan progres, supaya worker tidak
  dibanjiri permintaan serentak. Worker yang tidak menjawab dalam 6 detik dihitung mati.
- **"Ganti token"** (hanya LB) membuat token langganan baru; lihat bagian kunci tautan langganan.

### Dashboard: backup state & riwayat deploy

- **Export state** mengunduh berkas JSON berisi daftar Worker (nama, host, jenis, UUID/domains)
  dan jumlah config yang pernah dibuat. **Import state** membacanya kembali dengan validasi ketat:
  hanya JSON objek dengan daftar `workers`, jenis worker yang dikenal, id duplikat dibuang, dan
  berkas rusak ditolak — state lama tidak diubah kalau impor gagal.
- **Riwayat deploy** menampilkan 20 deploy terakhir (nama script, jenis, host, aksi `deploy` atau
  `redeploy-all`, waktu). Catatan ditulis setelah deploy sukses dan dibaca lewat RPC yang
  memverifikasi hash sesi: admin melihat semua akun, user biasa hanya barisnya sendiri. Fitur ini
  butuh `sql/2026-11-15-deploy-log.sql` (sudah dijalankan 15 Nov 2026; anon hanya boleh menulis, membaca lewat RPC ber-hash); kalau migrasi belum ada panel hanya menampilkan
  catatan bahwa migrasinya belum dijalankan (deploy tetap sukses, tidak ada error).

### Halaman Status (admin)

Menu **Status** (muncul untuk admin) menampilkan irisan pool langsung dari Supabase: total aktif,
terbukti tembus dari edge, terbukti mati di edge, belum diprobe, `tls_ok`, bukti vantage host, dan
baris segar <6 jam — plus kondisi siklus terakhir cron-worker. Angka yang tidak bisa dibaca
(kolom migrasi belum ada, atau worker cron belum ter-deploy) ditulis "-" beserta alasannya.

### Deploy ulang semua Worker

Sekali klik "Deploy ulang semua Worker tersimpan" di halaman Deploy mengirim ulang setiap worker
yang tercatat (satu per satu) memakai kredensial yang sedang terisi di form — berguna setelah
template atau urutan pool berubah. Proses berhenti dengan pesan jelas kalau kena batas `/api/cf`
(10 permintaan per 10 menit); worker yang sudah sukses tetap dilaporkan sukses, sisanya dilewati
dan bisa diulang setelah waktu yang disebut di pesan.

## Relay UDP (di luar panel)

Worker Cloudflare tidak punya UDP keluar, jadi UDP non-DNS (QUIC/HTTP3, game, WireGuard, NTP)
ditutup cepat oleh worker. Template yang dikirim panel
(`frontend/source/panvlesscloudflare.js`, `TIER_FREE = true`) memang **tidak** memakai relay UDP,
dan **form Deploy tidak lagi punya isian relay**: tidak ada field host/port/TLS/rahasia di halaman
Deploy, jadi panel tidak pernah mengirim binding relay. Satu-satunya `vars` yang dikirim panel
adalah `UUID_ALLOWLIST`, dan itu pun hanya kalau field UUID pada form diisi.

Kalau nanti relay ingin diaktifkan, relaynya tetap dipasang **di luar panel** — repo
[`Pan-VlessRelay`](https://github.com/jhopan/Pan-VlessRelay) menyediakan Docker siap pakai, dan
bindingnya dipasang lewat `wrangler`/dashboard Cloudflare atau lewat `deploy-bulk.mjs`. Worker
hanya akan memakai relay itu kalau template di-deploy dengan `TIER_FREE` di-flip ke `false`.

### Di mana relay bisa dijalankan

Relay butuh **port TCP masuk** (worker menyambung ke situ) dan **UDP keluar** (untuk mengirim
datagram). Itu menentukan platform yang bisa dipakai:

| Platform | Relay TCP (sekarang) | Catatan |
|---|---|---|
| VPS biasa (IP publik) | ✅ | Paling sederhana: `docker run -p 7300:7300/tcp` |
| **VPS NAT** (IP bersama, port dipetakan) | ✅ | Asal provider memberi **port forward TCP** + mengizinkan UDP keluar. Cek kuota bandwidth |
| Laptop/rumah di belakang NAT | ⚠️ | Butuh terowongan TCP (mis. SSH `-L`) atau port forward router; sudah diuji lewat SSH tunnel |
| **Render** (web service) | ❌ untuk TCP | Render tidak memberi ingress TCP publik; tapi Render **mendukung WebSocket masuk** → perlu varian relay berbasis WebSocket |
| Railway / Fly.io | ✅ (TCP proxy) | Butuh mengaktifkan TCP proxy / service TCP |
| **Vercel** | ❌ | Vercel Functions bersifat request/response (tanpa server TCP maupun WebSocket persisten) |

Kalau hosting-mu hanya mengizinkan HTTP/WebSocket (Render, Railway tanpa TCP proxy), jalur
yang masuk akal adalah **relay versi WebSocket** (worker menyambung via `fetch` dengan
`Upgrade: websocket`) — belum dibuat; protokol v1 sekarang murni TCP.

**Binding yang dibutuhkan worker** (dipasang di luar panel — form Deploy tidak menyediakannya):

| Binding Worker | Isi | Contoh |
|---|---|---|
| `RELAY_SERVER_UDP` | host relay | `relay.domainmu.com` |
| `RELAY_SERVER_PORT` | port relay | `7300` |
| `RELAY_SERVER_TLS` | pakai TLS | `1` (relay di port 443 dengan sertifikat) |
| `RELAY_SECRET` | rahasia relay | harus sama dengan `RELAY_SECRET` di relay |

`/api/cf` menerima nilai itu sebagai `vars`, memvalidasinya lewat `normalizeVars`, lalu memasangnya
sebagai binding `plain_text` pada Worker saat upload; respons deploy menampilkan daftar env yang
terpasang. Tanpa binding itu perilakunya seperti sekarang: DNS tetap dijawab lewat DoH dan UDP
selain DNS ditutup cepat. Rahasia wajib diisi kalau host diisi — relay menolak sambungan tanpa
rahasia yang benar.

Deploy massal (`deploy-bulk.mjs`) memakai env shell dengan nama yang sama
(`RELAY_SERVER_UDP`, `RELAY_SERVER_PORT`, `RELAY_SERVER_TLS`, `RELAY_SECRET`) dan memasangnya
sebagai binding untuk setiap worker. Ingat: selama template yang di-upload masih memakai
`TIER_FREE = true`, binding itu diabaikan worker.

Catatan: jalur UDP lewat relay menambah satu hop dan memakai TCP, jadi QUIC berat bisa lebih
lambat — protokol UDP kecil (DNS/NTP/game ringan) paling cocok.

## Bulk Deploy Script (Lokal)

`deploy-bulk.mjs` adalah script lokal, bukan fitur frontend dan tidak ter-deploy ke Cloudflare Pages. Script membaca kredensial dari `.env`; jangan taruh key pada source code atau commit ke GitHub.

Tambahkan kredensial Cloudflare ini ke `.env`:

```env
CF_EMAIL=your_email
CF_API_KEY=your_cf_global_api_key
CF_ACCOUNT_ID=your_account_id
```

Siapkan `workers.txt`, satu nama Worker per baris:

```txt
vpn-sg-01
vpn-sg-02
vpn-id-01
```

Jalankan:

```bash
node deploy-bulk.mjs
```

Menu tersedia:

```txt
1. Deploy Worker (dari file workers.txt)
2. Deploy Worker (input manual)
3. Cek Status Worker (baca deployed.txt)
4. Cek Status Worker (input URL)
5. Hapus Worker
0. Keluar
```

Pada deploy, script memilih salah satu dari **dua** source — `frontend/source/panvlesscloudflare.js` (VPN Worker) atau `frontend/source/load-balancer.js` (Load Balancer); upload satu per satu; enable `workers.dev`; lalu cek endpoint `/myip`. Hanya Worker yang menjawab HTTP status `<500` dicatat sebagai online.

Hasil deploy disimpan ke `deployed.txt`:

```txt
vpn-sg-01    https://vpn-sg-01.example.workers.dev    ✅ ONLINE
vpn-id-01    GAGAL                                  ❌ - worker tidak response
```

Cek ulang dari menu 3 menghasilkan `status.txt`.

## Generator

**Mode Local:**
- Pilih VPN Worker
- Filter proxy by negara/penyedia, atau pilih proxy spesifik
- Pilih format output (Raw/V2Ray/Clash/Sing-box)
- Klik "Buat Config"

**Mode Subscription:**
- Pilih Load Balancer
- Set format, jumlah, filter negara
- Klik "Buat Config" → fetch dari LB worker
- URL subscription muncul setelah generate

### QR config

Setelah config dibuat, tombol **QR** menampilkan kode QR untuk:

- config `vless://` (satu QR per config; kalau hasilnya banyak baris, hanya baris URI pertama yang
  dibuatkan QR), dan
- **URL langganan** di mode subscription (termasuk token `&t=` sehingga aplikasi klien langsung bisa
  mengimpor langganan).

Mode rotasi ikut mendapat QR karena hasilnya juga `vless://`. Batasnya: format **V2Ray (Base64),
Clash YAML, dan Sing-box JSON tidak dibuatkan QR** — teksnya bukan URI yang bisa dipindai jadi
config, jadi panel memberi pesan, bukan QR kosong. Pembuatan QR memakai lib yang di-vendor di repo
(`frontend/vendor/qrcode.js`, `qrcode@1.4.4`, MIT), bukan CDN: URL langganan yang mengandung token
tidak pernah dikirim ke pihak lain, dan QR tetap bisa dibuat saat offline setelah halaman termuat.

## Author

**jhopanstore**

## License

MIT
