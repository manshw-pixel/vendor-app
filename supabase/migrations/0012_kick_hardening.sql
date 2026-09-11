-- Hardening kick_send_notification() against the failure that cost two hours on the day
-- 0011 went live.
--
-- What happened: both Vault secrets were pasted with a LEADING SPACE. First in the names,
-- so the lookups in 0011 found nothing and the function returned early -- every cron run
-- reported `succeeded` while nothing was ever sent, for twenty minutes, with no error
-- anywhere to look at. Then in the URL value, so pg_net raised "invalid URL" every single
-- minute and the job failed sixty times an hour.
--
-- Both are operator typos and neither deserves to look the way it looked. This version
-- trims what it reads and says out loud when it cannot proceed.

create or replace function kick_send_notification() returns void
  language plpgsql security definer set search_path = public as $$
declare
  -- Every character a paste can carry in that SQL trim() would leave behind: trim() strips
  -- spaces and nothing else, so a value ending in a newline -- as likely as one starting
  -- with a space, and just as invisible in the dashboard -- would survive it and be sent
  -- as a broken password. Caught by tests/kick.test.mjs.
  c_pad    constant text := E' \t\r\n';
  v_url    text;
  v_secret text;
begin
  select btrim(decrypted_secret, c_pad) into v_url
    from vault.decrypted_secrets where btrim(name, c_pad) = 'send_notification_url';
  select btrim(decrypted_secret, c_pad) into v_secret
    from vault.decrypted_secrets where btrim(name, c_pad) = 'send_notification_secret';

  -- Unset is a legitimate state, not a fault: the sender ships dark, and this migration
  -- can be pushed before the secrets exist. Silence is right here -- but only here.
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return;
  end if;

  -- Set but unusable is a DIFFERENT state, and the one that hid for two hours. Raising a
  -- warning puts it in the Postgres log with a message naming the actual problem, while
  -- leaving the job `succeeded` so a typo does not fill cron.job_run_details with a
  -- pg_net stack trace every minute. `raise warning` does not abort the transaction.
  if v_url !~ '^https://' then
    raise warning 'kick_send_notification: send_notification_url is not an https URL (%); '
                  'no request sent', left(v_url, 120);
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-send-secret', v_secret),
    body    := '{}'::jsonb
  );
end $$;

revoke all on function kick_send_notification() from public, anon, authenticated;
