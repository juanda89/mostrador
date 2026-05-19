-- =========================================================
-- CRON — tick cada minuto que llama a la edge function cron-tick.
-- =========================================================
-- Después de aplicar esta migración a la DB remota, configurar las variables:
--
--   ALTER DATABASE postgres SET app.tick_url =
--     'https://<PROJECT_REF>.supabase.co/functions/v1/cron-tick';
--   ALTER DATABASE postgres SET app.cron_secret = '<RANDOM_HEX_SECRET>';
--
-- La función edge revisa qué negocios deben recibir reporte o auto-cerrar
-- turnos en esa hora local (lógica en supabase/functions/cron-tick/index.ts).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'mostrador-tick',
  '* * * * *',
  $$ SELECT net.http_post(
       url := current_setting('app.tick_url'),
       headers := jsonb_build_object(
         'x-cron-secret', current_setting('app.cron_secret'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb
     ) $$
);
