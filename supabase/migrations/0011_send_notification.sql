-- Draining outbound_messages to WhatsApp.
--
-- The queue has been filling since 0003: issue_token() writes 'token_issued' and
-- complete_bill() writes 'points_awarded', both inside the billing transaction, both
-- deliberately never sent inline. Nothing has ever emptied it. This migration supplies
-- the two database-side pieces of that drain -- an atomic claim, and a cron tick that
-- wakes the Edge Function -- while the send itself lives in
-- supabase/functions/send-notification/.

-- ---------------------------------------------------------------------------
-- A claimed state.
--
-- Without it, two overlapping invocations both read the same 'pending' row and the
-- customer gets their token twice. 'sending' is the row saying "an invocation owns me".
-- ---------------------------------------------------------------------------
alter table outbound_messages drop constraint outbound_messages_status_check;
alter table outbound_messages add constraint outbound_messages_status_check
  check (status in ('pending','sending','sent','failed'));

-- Twilio's message SID, kept so a customer complaint can be traced to a delivery log.
alter table outbound_messages add column provider_message_id text;

-- ---------------------------------------------------------------------------
-- The claim.
--
-- One statement: select, lock, mark and increment together. `for update skip locked` is
-- what makes concurrent invocations take disjoint batches rather than queue behind each
-- other, and the attempts increment happens BEFORE any HTTP does, so a function that
-- dies mid-send cannot loop forever on the same row.
--
-- Rows stuck in 'sending' are reclaimed after five minutes. That window is the price of
-- a crashed invocation: long enough that it never races a live send (the function's own
-- work is seconds), short enough that a customer's token is not stranded.
-- ---------------------------------------------------------------------------
create function claim_outbound_messages(p_limit integer default 20)
  returns table (id uuid, template_key text, payload jsonb, mobile text)
  language sql security definer set search_path = public as $$
  with claimed as (
    update outbound_messages m
       set status = 'sending', attempts = attempts + 1
     where m.id in (
       select c.id from outbound_messages c
        where (c.status = 'pending'
               or (c.status = 'sending' and c.created_at < now() - interval '5 minutes'))
          -- Mirrors MAX_ATTEMPTS in send-notification/sender.ts. Deliberately duplicated:
          -- the claim must hold even if the function is redeployed with another value,
          -- and a plpgsql cross-check would only move the copy, not remove it.
          and c.attempts < 5
        order by c.created_at
        limit p_limit
        for update skip locked
     )
    returning m.id, m.template_key, m.payload, m.customer_id
  )
  -- A left join, not an inner one: a message whose customer was deleted must still come
  -- back so the function can mark it failed. Dropped here, it would be claimed on every
  -- tick and never resolved.
  select c.id, c.template_key, c.payload, cu.mobile
    from claimed c
    left join customers cu on cu.id = c.customer_id;
$$;

-- Same posture as expire_points(): nothing a browser session holds may run this. The
-- Edge Function reaches it with the service role key, which is not a client secret.
revoke all on function claim_outbound_messages(integer) from public, anon, authenticated;
grant execute on function claim_outbound_messages(integer) to service_role;

-- ---------------------------------------------------------------------------
-- The tick.
--
-- pg_cron cannot call an Edge Function directly, so it posts to one over pg_net. Both the
-- URL and the shared secret come from Vault rather than this file -- migrations are
-- committed, and a secret in git is a secret published.
--
-- Two operator steps on Cloud, neither of which a migration can do (see README):
--   1. enable the `pg_net` extension in Database > Extensions;
--   2. create two Vault secrets, `send_notification_url` (the function's https URL) and
--      `send_notification_secret` (any long random string, also set as the function's
--      SEND_NOTIFICATION_SECRET).
--
-- Missing either secret is a no-op, not an error: this migration can be pushed before the
-- function is deployed, and the queue simply waits.
-- ---------------------------------------------------------------------------
create function kick_send_notification() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'send_notification_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'send_notification_secret';

  if v_url is null or v_secret is null then
    return;
  end if;

  -- Fire and forget. pg_net queues the request and returns immediately, so a slow or
  -- unreachable function never holds this transaction -- or the cron worker -- open.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-send-secret', v_secret),
    body    := '{}'::jsonb
  );
end $$;

revoke all on function kick_send_notification() from public, anon, authenticated;

-- Every minute. A customer waiting on a token number notices ten minutes; they do not
-- notice sixty seconds. An empty queue costs one claim query returning no rows.
select cron.schedule('vendor-app-send-notification', '* * * * *',
                     $$select kick_send_notification()$$);
