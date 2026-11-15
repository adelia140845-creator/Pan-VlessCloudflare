-- sql/2026-11-15-deploy-log-trim.sql
--
-- Retensi riwayat deploy. Tabel `deploy_log` hanya menerima INSERT dari anon (panel menulis satu
-- baris tiap deploy sukses) dan dibaca lewat RPC `deploy_log_list`; tidak ada yang membersihkannya,
-- jadi tabelnya tumbuh tanpa batas.
--
-- Fungsi di bawah dijalankan oleh scanner (service key) pada langkah housekeeping pipeline harian.
-- Hanya `service_role` yang boleh memanggilnya: anon/authenticated dicabut, termasuk dari PUBLIC
-- (default Postgres memberi EXECUTE ke PUBLIC kalau tidak dicabut).
--
-- Jalankan: npx supabase@latest db query --remote=<ref> -f sql/2026-11-15-deploy-log-trim.sql --yes

create or replace function public.deploy_log_trim(p_keep_days int default 30)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_days int := least(greatest(coalesce(p_keep_days, 30), 1), 3650);
  v_deleted int;
begin
  delete from public.deploy_log
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.deploy_log_trim(int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.deploy_log_trim(int) to service_role;
  end if;
end $$;

-- Bukti yang diharapkan: dengan service key -> 200 dan balasan berupa jumlah baris terhapus (integer);
-- dengan anon key -> 401/403. Pemanggilan dengan `p_keep_days` besar (mis. 3650) tidak menghapus apa pun.

notify pgrst, 'reload schema';
