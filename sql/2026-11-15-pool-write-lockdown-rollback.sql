-- sql/2026-11-15-pool-write-lockdown-rollback.sql
--
-- Mengembalikan keadaan sebelum `2026-11-15-pool-write-lockdown.sql`:
-- anon/authenticated boleh SELECT + INSERT + UPDATE pada `public.proxy_pool` (DELETE tetap dicabut
-- oleh migrasi prune, jadi tidak dikembalikan di sini).
--
-- PERINGATAN: setelah rollback, siapa pun yang memegang anon key bisa menulis ke tabel pool lagi.
-- Pakai hanya untuk diagnosis sementara.

alter table if exists public.proxy_pool enable row level security;

drop policy if exists proxy_pool_select_anon on public.proxy_pool;
create policy proxy_pool_select_anon on public.proxy_pool for select to anon, authenticated using (true);

drop policy if exists proxy_pool_insert_anon on public.proxy_pool;
create policy proxy_pool_insert_anon on public.proxy_pool for insert to anon, authenticated with check (true);

drop policy if exists proxy_pool_update_anon on public.proxy_pool;
create policy proxy_pool_update_anon on public.proxy_pool for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.proxy_pool to anon, authenticated;

notify pgrst, 'reload schema';
