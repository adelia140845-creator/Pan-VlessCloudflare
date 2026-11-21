-- sql/2026-11-21-admin-actions-rollback.sql
--
-- Rollback untuk sql/2026-11-21-admin-actions.sql: mengembalikan definisi public.admin_action
-- PERSIS seperti sql/2026-11-14-auth-hardening.sql (hanya create/set_role/delete) — tanda tangan,
-- verifikasi admin, SECURITY DEFINER dan search_path sama; hanya dua cabang aksi baru yang hilang.
--
-- Konsekuensi: panel yang sudah memakai aksi 'set_password'/'unlock' akan menerima
-- "Aksi tidak dikenal: set_password" (errcode 22023) sampai migrasi dijalankan lagi; tidak ada
-- data yang dihapus — kunci login yang tidak dibuka lewat 'unlock' tetap bisa dibuka dengan
--   delete from public.login_attempts where username = 'nama_akun';
-- (lihat catatan OPERASIONAL di sql/2026-11-14-login-lockout.sql).
--
-- Grant tidak disentuh: tanda tangan fungsi tidak berubah, jadi hak EXECUTE yang lama tetap sah.

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
  end if;

  raise exception 'Aksi tidak dikenal: %', coalesce(p_action, '(null)') using errcode = '22023';
end;
$$;

grant execute on function public.admin_action(text, text, text, text, text, text) to anon, authenticated;
