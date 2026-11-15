-- sql/2026-11-15-deploy-log-trim-rollback.sql
--
-- Membuang fungsi retensi riwayat deploy. Tabel `deploy_log` dan RPC pembacanya tidak disentuh;
-- baris yang sudah terhapus oleh fungsi ini tidak bisa dikembalikan.

drop function if exists public.deploy_log_trim(int);

notify pgrst, 'reload schema';
