-- sql/2026-11-15-deploy-log.sql
--
-- Tujuan: riwayat deploy (audit) panel cfvpn-hub. Setiap deploy yang BERHASIL dicatat satu baris
-- oleh panel (halaman Deploy) dan dashboard menampilkan 20 baris terakhir lewat RPC ber-hash.
--
-- Kenapa di database: panel berjalan di browser, dan riwayat di localStorage hilang saat ganti
-- perangkat atau bersihkan data. Riwayat per akun + per script ini yang membuat "siapa men-deploy
-- apa, kapan" bisa ditelusuri setelah kejadian (mis. worker yang tiba-tiba berubah versinya).
--
-- IZIN — anon hanya boleh MENULIS, tidak pernah membaca tabelnya:
--   * INSERT anon/authenticated: panel menulis catatan setelah deploy sukses. Panel sengaja tidak
--     memakai `.select()` setelah insert, jadi PostgREST tidak menuntut hak SELECT untuk ini.
--     (Kalau suatu saat panel minta representasi balik, INSERT-nya akan gagal 401/403 — bukan
--     diam-diam berhasil, karena grant SELECT memang tidak ada.)
--   * SELECT TIDAK diberikan ke anon/authenticated. Riwayat berisi username + nama/host worker
--     semua akun, sedangkan data sejenis di tempat lain (user_states) justru dijaga RPC — membuka
--     SELECT di sini membuat anon key publik panel cukup untuk membaca aktivitas seluruh akun.
--     Pembacaan karena itu lewat public.deploy_log_list di bawah, yang memverifikasi hash sandi
--     pemanggil dan hanya memberi barisnya sendiri (user) atau semua baris (admin).
--   * Tidak ada UPDATE/DELETE untuk anon: catatan audit tidak bisa diubah/dihapus dari browser.
--
-- Aman dijalankan berkali-kali (idempotent) dan aman dijalankan sesudah versi lama berkas ini
-- (policy SELECT `using (true)` dari versi lama ikut dicabut di bawah). Jalankan di SQL editor
-- Supabase / db query. Urutan aman: setelah sql/2026-11-14-auth-hardening.sql (butuh users_custom).

-- ---------------------------------------------------------------------------------------
-- 1. Tabel. `bigserial` dipilih supaya id tidak bisa ditebak seperti uuid dan urutannya sama
--    dengan urutan penulisan (id ikut jadi tie-break saat created_at sama di detik yang sama).
--    Kolom `username`/`script_name`/`type`/`host` semuanya nullable: catatan audit tidak boleh
--    gagal ditulis hanya karena satu kolom kosong (baris tetap berguna lewat action + created_at).
--    `action` menyimpan "deploy" (satu worker dari form) atau "redeploy-all" (batch). Sengaja
--    tanpa CHECK supaya aksi baru di masa depan tidak butuh migrasi; panel memvalidasinya.
-- ---------------------------------------------------------------------------------------
create table if not exists public.deploy_log (
  id          bigserial primary key,
  username    text,
  script_name text,
  type        text,
  host        text,
  action      text,
  created_at  timestamptz not null default now()
);

-- Dashboard hanya butuh "20 terakhir": index menurun ini yang dipakai, jadi daftarnya tidak
-- memindai seluruh tabel saat riwayatnya sudah panjang.
create index if not exists deploy_log_created_at_idx
  on public.deploy_log (created_at desc);

-- Dipakai cabang "baris milik sendiri" di deploy_log_list (user biasa).
create index if not exists deploy_log_username_created_idx
  on public.deploy_log (username, created_at desc);

-- ---------------------------------------------------------------------------------------
-- 2. RLS + policy INSERT saja. Tidak ada policy SELECT/DELETE/UPDATE untuk anon.
-- ---------------------------------------------------------------------------------------
alter table public.deploy_log enable row level security;

drop policy if exists deploy_log_insert_anon on public.deploy_log;
create policy deploy_log_insert_anon on public.deploy_log for insert to anon, authenticated with check (true);

-- Versi lama berkas ini memberi SELECT `using (true)` ke anon; policy itu harus hilang. Policy
-- tidak menambah hak, tapi policy yang masih tertinggal akan langsung berlaku begitu ada grant
-- SELECT dari berkas lain — jadi keduanya (policy dan grant) dibersihkan di sini.
drop policy if exists deploy_log_select_anon on public.deploy_log;

-- ---------------------------------------------------------------------------------------
-- 3. Grant tingkat tabel: INSERT saja untuk anon/authenticated, dan SELECT DICABUT eksplisit
--    (supaya project yang pernah menjalankan versi lama berkas ini ikut bersih).
-- ---------------------------------------------------------------------------------------
grant insert on public.deploy_log to anon, authenticated;
revoke select, update, delete on public.deploy_log from anon, authenticated;

-- `bigserial` memakai sequence public.deploy_log_id_seq untuk nilai default id. INSERT sebagai
-- anon tetap gagal tanpa USAGE pada sequence itu ("permission denied for sequence"), dan itu satu
-- baris yang mudah terlewat karena policy-nya sudah benar.
grant usage, select on sequence public.deploy_log_id_seq to anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- 4. Pembacaan riwayat: deploy_log_list(p_username, p_hash, p_limit).
--
--    Verifikasi hash mengikuti pola get_state/save_state (sql/2026-11-14-state-hardening.sql):
--    yang dicocokkan adalah sha256 hex sandi, bukan sandinya. Bedanya, DI SINI hash yang tidak
--    cocok TIDAK raise: hasilnya nol baris. Alasannya, RPC ini hanya membaca (tidak ada data yang
--    bisa dirusak), dan pesan error per-username akan jadi oracle kecil untuk menebak username
--    yang ada; panel juga diminta tidak menampilkan error menakutkan untuk sesi basi.
--
--    admin -> 20 (p_limit) baris terbaru SEMUA akun; user biasa -> hanya baris username-nya.
--    p_limit dijaga 1..200 supaya panel tidak bisa menarik seluruh tabel dengan satu panggilan.
-- ---------------------------------------------------------------------------------------
create or replace function public.deploy_log_list(p_username text, p_hash text, p_limit int default 20)
returns table (
  id          bigint,
  username    text,
  script_name text,
  type        text,
  host        text,
  action      text,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := lower(btrim(coalesce(p_username, '')));
  v_role text;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  -- Username kosong atau hash tidak cocok: nol baris (lihat catatan di atas).
  if v_name = '' then
    return;
  end if;

  select coalesce(u.role, 'user')
    into v_role
    from public.users_custom u
   where u.username = v_name
     and u.password_hash = coalesce(p_hash, '')
   limit 1;

  if v_role is null then
    return;
  end if;

  if v_role = 'admin' then
    return query
      select l.id, l.username, l.script_name, l.type, l.host, l.action, l.created_at
        from public.deploy_log l
       order by l.created_at desc, l.id desc
       limit v_limit;
  end if;

  -- User biasa: hanya baris miliknya sendiri.
  return query
    select l.id, l.username, l.script_name, l.type, l.host, l.action, l.created_at
      from public.deploy_log l
     where l.username = v_name
     order by l.created_at desc, l.id desc
     limit v_limit;
end;
$$;

-- Hanya anon yang butuh RPC ini (login panel bukan Supabase Auth, jadi peran `authenticated`
-- tidak dipakai panel). Default Postgres memberi EXECUTE ke PUBLIC, jadi hak itu dicabut eksplisit
-- lebih dulu — kalau tidak, siapa pun yang login ke Supabase tetap bisa memanggilnya.
revoke all on function public.deploy_log_list(text, text, int) from public, authenticated;
grant execute on function public.deploy_log_list(text, text, int) to anon;

-- ---------------------------------------------------------------------------------------
-- 5. service_role (dipakai jalur istimewa di luar panel, mis. bersih-bersih riwayat lama) tetap
--    punya hak penuh; dijaga kondisional supaya berkas ini tidak gagal di project tanpa role itu.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.deploy_log to service_role';
    execute 'grant usage, select on sequence public.deploy_log_id_seq to service_role';
  else
    raise notice 'role service_role tidak ada; grant service_role dilewati';
  end if;
end;
$$;

-- PostgREST menyimpan skema + policy di cache; tanpa ini panel masih melihat tabel/policy lama.
notify pgrst, 'reload schema';
