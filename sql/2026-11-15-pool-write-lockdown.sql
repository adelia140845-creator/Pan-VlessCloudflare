-- sql/2026-11-15-pool-write-lockdown.sql
--
-- Tujuan: mencabut kemampuan TULIS `anon` (dan `authenticated`) pada `public.proxy_pool`.
-- Anon key bersifat publik (dipakai browser panel), jadi selama ini siapa pun yang tahu kunci itu
-- bisa menyuntik baris palsu atau membalik status baris asli -- termasuk menandai proxy mati sebagai
-- "tembus edge", yang langsung memengaruhi apa yang ditawarkan panel ke config klien.
--
-- Setelah migrasi ini, penulis yang sah adalah:
--   * scanner Go (Pan-ProxyScanner) di server, memakai `supabase_service_key` untuk push verdict;
--   * cron-worker `proxy-cron-worker`, memakai secret `SUPABASE_SERVICE_KEY` untuk probe edge.
-- Pembaca tetap `anon`: panel (generator, halaman Proxy, halaman Status) dan Load Balancer user.
--
-- URUTAN WAJIB: pastikan scanner dan cron-worker SUDAH memakai service key lebih dulu (rilis scanner
-- + `npx wrangler secret put SUPABASE_SERVICE_KEY` di cron-worker), baru jalankan berkas ini.
-- Kalau dibalik, push scanner dan probe edge berhenti bisa menulis.
--
-- Idempoten: aman dijalankan berulang.
--
-- Jalankan: npx supabase@latest db query --remote=<ref> -f sql/2026-11-15-pool-write-lockdown.sql --yes

alter table if exists public.proxy_pool enable row level security;

-- Policy tulis untuk anon dibuang; policy SELECT anon dipertahankan (baca tetap boleh).
drop policy if exists proxy_pool_insert_anon on public.proxy_pool;
drop policy if exists proxy_pool_update_anon on public.proxy_pool;
drop policy if exists proxy_pool_delete_anon on public.proxy_pool;

-- Cabut hak tulis; TRUNCATE juga dicabut walau PostgREST tidak mengeksposnya.
revoke insert, update, delete, truncate on public.proxy_pool from anon, authenticated;
grant select on public.proxy_pool to anon, authenticated;

-- service_role melewati RLS, tapi tetap butuh grant tabel.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.proxy_pool to service_role;
  end if;
end $$;

-- Bukti yang diharapkan sesudah menjalankan:
--   * information_schema.role_table_grants: anon hanya SELECT
--   * PATCH /rest/v1/proxy_pool?ip=eq.0.0.0.0 dengan anon key -> 401/403
--   * PATCH yang sama dengan service key -> 204
--   * GET /rest/v1/proxy_pool?select=ip&limit=1 dengan anon key -> 200

notify pgrst, 'reload schema';
