-- Hvert 10. minutt: én synk-kjøring per aktiv klient. Idempotent (samme jobbnavn oppdateres).
select cron.schedule(
  'sqs-tripletex-sync',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := jsonb_build_object('client_id', c.id, 'trigger', 'cron'),
    timeout_milliseconds := 5000
  )
  from public.clients c
  where c.active;
  $job$
);

-- Daglig opprydding av gamle logger
select cron.schedule('sqs-tripletex-prune', '17 3 * * *', $job$ select public.prune_sync_runs(); $job$);

-- Feilsøking:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
