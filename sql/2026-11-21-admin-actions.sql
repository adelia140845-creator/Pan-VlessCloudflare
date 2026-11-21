-- sql/2026-11-21-admin-actions.sql
--
-- Tujuan: menambah DUA aksi ke RPC public.admin_action yang sudah ada
-- (sql/2026-11-14-auth-hardening.sql), tanpa mengubah apa pun yang lain:
--
--   'set_password' -> menimpa public.users_custom.password_hash milik target dengan nilai yang
--                     dikirim panel. Nilai itu HASH, bukan sandi mentah: panel sudah menghitung
--                     SHA-256 hex (karena kolom password_hash memang menyimpan hex itu, lihat
--                     verify_login/register_user). Bentuk selain 64 hex ditolak.
--   'unlock'       -> membersihkan kunci brute force target di public.login_attempts
--                     (sql/2026-11-14-login-lockout.sql), memakai helper login_lockout_clear
--                     bila ada. Tanpa berkas kunci itu, aksi ini mengembalikan false, bukan error.
--
-- Yang SENGAJA tidak berubah (jangan diubah tanpa alasan):
--   * tanda tangan fungsi (p_actor, p_actor_hash, p_action, p_target, p_role, p_password) --
--     PostgREST memanggil dengan nama parameter itu, dan menambah parameter akan membuat panggilan
--     jadi ambigu (PGRST203).
--   * verifikasi pelaku: harus baris users_custom ber-role 'admin' dengan password_hash yang
--     cocok dengan p_actor_hash. Anon key saja tetap tidak cukup.
--   * SECURITY DEFINER + set search_path = public, extensions.
--   * grant execute ke anon, authenticated (tidak ada grant/revoke baru; barisnya ditulis ulang
--     di bawah hanya supaya berkas ini berdiri sendiri).
--
-- Aman dijalankan berkali-kali (CREATE OR REPLACE, idempotent), aman dijalankan sebelum/sesudah
-- panel versi baru (aksi create/set_role/delete berperilaku persis sama), dan aman tanpa
-- sql/2026-11-14-login-lockout.sql.
--
-- PERINGATAN URUTAN: jalankan berkas ini SESUDAH sql/2026-11-14-auth-hardening.sql. Kalau
-- auth-hardening dijalankan ulang SESUDAHNYA, definisi lama di sana menimpa fungsi ini (CREATE OR
-- REPLACE, tanpa error) dan dua aksi baru hilang — jalankan ulang berkas ini kalau ragu.
--
-- Rollback: sql/2026-11-21-admin-actions-rollback.sql (mengembalikan definisi tiga aksi).

-- ---------------------------------------------------------------------------------------
-- Aksi admin: pelaku harus admin DAN hash sandinya cocok (anon key saja tidak cukup).
--   p_action: 'create' | 'set_role' | 'delete' | 'set_password' | 'unlock'
--   true = ada baris yang berubah, false = tidak ada (mis. username sudah ada / bukan target).
-- ---------------------------------------------------------------------------------------
create or replace function public.admin_action(
  p_actor text,
  p_actor_hash text,
  p_action text,
  p_target text default null,
  p_role text default null,
  p_password text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor text := lower(btrim(coalesce(p_actor, '')));
  v_target text := lower(btrim(coalesce(p_target, '')));
  v_rows integer := 0;
  v_hash text := lower(btrim(coalesce(p_password, '')));
begin
  if not exists (
    select 1
    from public.users_custom u
    where u.username = v_actor
      and u.role = 'admin'
      and u.password_hash = coalesce(p_actor_hash, '')
  ) then
    raise exception 'Hanya admin yang boleh melakukan ini.' using errcode = '42501';
  end if;

  if p_action = 'create' then
    if v_target = '' or position(' ' in v_target) > 0 or length(coalesce(p_password, '')) < 6 then
      raise exception 'Username atau sandi tidak valid.' using errcode = '22023';
    end if;
    insert into public.users_custom (username, password_hash, role)
    values (v_target, encode(digest(p_password, 'sha256'), 'hex'), coalesce(nullif(p_role, ''), 'admin'))
    on conflict (username) do nothing;
    get diagnostics v_rows = row_count;
    return v_rows > 0;

  elsif p_action = 'set_role' then
    if p_role is null or p_role not in ('admin', 'user') then
      raise exception 'Role tidak dikenal.' using errcode = '22023';
    end if;
    update public.users_custom
       set role = p_role
     where username = v_target
       and username <> v_actor;
    get diagnostics v_rows = row_count;
    return v_rows > 0;

  elsif p_action = 'delete' then
    delete from public.users_custom
     where username = v_target
       and username <> v_actor;
    get diagnostics v_rows = row_count;
    return v_rows > 0;

  -- Panel mengirim hash (SHA-256 hex 64 karakter) yang sudah dihitungnya, bukan sandi mentah;
  -- di sini nilai itu ditulis apa adanya ke kolom password_hash (format kolomnya memang hex itu).
  -- Beda dengan 'create' yang menerima sandi mentah lalu meng-hash-nya.
  elsif p_action = 'set_password' then
    if v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'Hash sandi harus 64 karakter hex.' using errcode = '22023';
    end if;
    update public.users_custom
       set password_hash = v_hash
     where username = v_target;
    get diagnostics v_rows = row_count;
    return v_rows > 0;

  -- Membuka kunci brute force target. login_lockout_clear dinormalkan sendiri (lower/btrim),
  -- jadi v_target bisa dipakai langsung. Row_count diambil sebelum dibersihkan karena helper
  -- mengembalikan void (tidak memberi tahu ada berapa baris yang hilang).
  elsif p_action = 'unlock' then
    if to_regclass('public.login_attempts') is null then
      return false; -- migrasi kunci login belum dijalankan: tidak ada kunci untuk dibuka
    end if;
    if to_regprocedure('public.login_lockout_clear(text)') is not null then
      select count(*) into v_rows from public.login_attempts a where a.username = v_target;
      perform public.login_lockout_clear(v_target);
    else
      delete from public.login_attempts where username = v_target;
      get diagnostics v_rows = row_count;
    end if;
    return v_rows > 0;
  end if;

  raise exception 'Aksi tidak dikenal: %', coalesce(p_action, '(null)') using errcode = '22023';
end;
$$;

-- Grant tidak berubah dari sql/2026-11-14-auth-hardening.sql (tanda tangan fungsi sama, jadi
-- haknya sudah ada). Baris ini no-op yang ditulis ulang supaya berkas ini berdiri sendiri.
grant execute on function public.admin_action(text, text, text, text, text, text) to anon, authenticated;
