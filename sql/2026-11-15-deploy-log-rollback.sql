-- sql/2026-11-15-deploy-log-rollback.sql
--
-- Rollback untuk sql/2026-11-15-deploy-log.sql: mengembalikan database ke keadaan sebelum tabel
-- riwayat deploy ada — tabel, index, policy, dan RPC pembacaan public.deploy_log_list.
--
-- PERINGATAN: isi riwayat deploy IKUT HILANG dan tidak ada backup otomatis. Kalau catatannya masih
-- dibutuhkan, salin dulu sebelum menjalankan berkas ini (jalankan lewat SQL editor / db query):
--
--   copy (select * from public.deploy_log order by id) to stdout with (format csv, header true);
--
-- Setelah rollback, panel tetap bekerja seperti biasa: blok "Riwayat deploy" di dashboard hanya
-- menampilkan catatan "migrasi belum dijalankan" (kode PGRST202/42P01 ditangani sebagai "belum
-- ada", bukan error), dan deploy tetap berjalan karena penulisan log bersifat best-effort —
-- termasuk saat RPC pembacaan sudah hilang sementara tabelnya belum.
--
-- Aman dijalankan berkali-kali (idempotent).

-- 1. RPC pembacaan riwayat (fungsi milik migrasi ini).
drop function if exists public.deploy_log_list(text, text, int);

-- 2. Tabel beserta policy/index-nya (`drop table` sudah membawa index miliknya).
drop index if exists public.deploy_log_username_created_idx;
drop index if exists public.deploy_log_created_at_idx;
drop table if exists public.deploy_log;

notify pgrst, 'reload schema';
