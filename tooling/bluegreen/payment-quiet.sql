begin read only;
-- Branch before referencing new columns so the same gate works before migration 0065.
select
  (to_regclass('public.order_items') is not null
    and to_regclass('public.refund_request_items') is not null
    and to_regclass('public.refund_item_allocations') is not null
    and (select count(*) from information_schema.columns where table_schema = 'public' and
      (table_name, column_name) in (('orders','model_version'),('orders','quantity'),('orders','version'),('orders','settled_payment_id'),('orders','entitlements_on_hold'),('inventory_reservations','order_item_id'),('refunds','protection_scope'))) = 7
    and (select count(*) from information_schema.columns where table_schema = 'public'
      and (table_name, column_name) in (('orders','registration_id'),('invoice_requests','registration_id')) and is_nullable = 'YES') = 2) as batch_complete,
  (to_regclass('public.order_items') is not null or to_regclass('public.refund_request_items') is not null
    or to_regclass('public.refund_item_allocations') is not null
    or exists (select 1 from information_schema.columns where table_schema = 'public' and
      (table_name, column_name) in (('orders','model_version'),('orders','quantity'),('orders','version'),('orders','settled_payment_id'),('orders','entitlements_on_hold'),('inventory_reservations','order_item_id'),('refunds','protection_scope')))
    or exists (select 1 from information_schema.columns where table_schema = 'public'
      and (table_name, column_name) in (('orders','registration_id'),('invoice_requests','registration_id')) and is_nullable = 'YES')) as batch_present
\gset
\if :batch_complete
select
  (select count(*) from payments where provider = 'wechatpay'
    and status in ('preparing', 'pending', 'processing', 'query_pending', 'close_pending', 'unknown')) as active_attempts,
  (select count(*) from payment_notification_inbox inbox where status <> 'processed'
    and not exists (
      select 1 from payments settled
      inner join orders paid_order on paid_order.id = settled.order_id
      left join lateral (
        select coalesce(sum(r.amount), 0) as amount from refunds r
        where r.payment_id = settled.id and r.order_id = paid_order.id
          and r.organization_id = paid_order.organization_id and r.currency = settled.currency
          and r.status = 'succeeded'
      ) returned on true
      where (
        (paid_order.model_version = 1 and exists (select 1 from tickets issued where issued.registration_id = paid_order.registration_id))
        or (paid_order.model_version = 2 and paid_order.settled_payment_id = settled.id
          and (select count(*) from order_items oi where oi.order_id = paid_order.id) = paid_order.quantity
          and not exists (select 1 from order_items oi where oi.order_id = paid_order.id
            and not exists (select 1 from tickets issued inner join registrations r on r.id = issued.registration_id where issued.registration_id = oi.registration_id and ((oi.state = 'active' and issued.status in ('valid','used') and r.status in ('confirmed','checked_in','completed') and r.superseded_at is null) or (oi.state = 'cancelled' and issued.status = 'cancelled')))))
      ) and paid_order.id = inbox.order_id and paid_order.organization_id = inbox.organization_id
        and (
          (paid_order.status = 'paid' and settled.status = 'succeeded')
          or (paid_order.status = 'partially_refunded' and settled.status = 'succeeded'
            and returned.amount > 0 and returned.amount < settled.amount)
          or (paid_order.status = 'refunded' and settled.status = 'refunded'
            and returned.amount = settled.amount)
        )
        and settled.provider = 'wechatpay'
        and settled.external_id = inbox.payload->>'externalId'
        and settled.amount::text = inbox.payload->>'amount'
        and settled.currency = inbox.payload->>'currency'
    )) as unsettled_notifications,
  (select count(*) from orders o where
    (o.model_version = 1 and o.status = 'paid' and not exists (select 1 from tickets t where t.registration_id = o.registration_id))
    or (o.model_version = 2 and (o.entitlements_on_hold or exists (select 1 from refunds r where r.order_id = o.id and r.fulfillment_attention is not null) or (
      (o.status in ('paid', 'partially_refunded', 'refunded') or exists (select 1 from payments p where p.order_id = o.id and p.succeeded_at is not null))
      and (o.settled_payment_id is null
        or (select count(*) from order_items oi where oi.order_id = o.id) <> o.quantity
        or exists (select 1 from order_items oi where oi.order_id = o.id
          and not exists (select 1 from tickets t inner join registrations r on r.id = t.registration_id where t.registration_id = oi.registration_id and ((oi.state = 'active' and t.status in ('valid','used') and r.status in ('confirmed','checked_in','completed') and r.superseded_at is null) or (oi.state = 'cancelled' and t.status = 'cancelled')))))
    )))) as paid_without_tickets;
\elif :batch_present
-- A partial schema cannot establish settlement; fail closed.
select 1 / 0;
\else
select
  (select count(*) from payments where provider = 'wechatpay'
    and status in ('preparing', 'pending', 'processing', 'query_pending', 'close_pending', 'unknown')) as active_attempts,
  (select count(*) from payment_notification_inbox inbox where status <> 'processed'
    and not exists (
      select 1 from payments settled
      inner join orders paid_order on paid_order.id = settled.order_id
      inner join tickets issued on issued.registration_id = paid_order.registration_id
      left join lateral (
        select coalesce(sum(r.amount), 0) as amount from refunds r
        where r.payment_id = settled.id and r.order_id = paid_order.id
          and r.organization_id = paid_order.organization_id and r.currency = settled.currency
          and r.status = 'succeeded'
      ) returned on true
      where paid_order.id = inbox.order_id and paid_order.organization_id = inbox.organization_id
        and (
          (paid_order.status = 'paid' and settled.status = 'succeeded')
          or (paid_order.status = 'partially_refunded' and settled.status = 'succeeded'
            and returned.amount > 0 and returned.amount < settled.amount)
          or (paid_order.status = 'refunded' and settled.status = 'refunded'
            and returned.amount = settled.amount)
        )
        and settled.provider = 'wechatpay'
        and settled.external_id = inbox.payload->>'externalId'
        and settled.amount::text = inbox.payload->>'amount'
        and settled.currency = inbox.payload->>'currency'
    )) as unsettled_notifications,
  (select count(*) from orders o where o.status = 'paid'
    and not exists (select 1 from tickets t where t.registration_id = o.registration_id)) as paid_without_tickets;
\endif
commit;
