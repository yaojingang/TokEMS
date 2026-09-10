import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireFromDatabase = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);
const { Pool } = requireFromDatabase('pg');

async function withFixtureDatabase(databaseUrl, callback) {
  assert.ok(databaseUrl, 'Legacy refund fixtures require an explicit isolated DATABASE_URL');
  assert.ok(
    process.env.CI === 'true' || process.env.TOKEMS_ISOLATED_SMOKE === 'true',
    'Legacy fixtures require CI or TOKEMS_ISOLATED_SMOKE=true',
  );
  const destination = new URL(databaseUrl);
  assert.notEqual(
    destination.port,
    '15432',
    'Legacy fixtures cannot use the shared preview database',
  );
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
    await pool.end();
  }
}

// After testing the v2 rejection, reuse this run's paid single-seat sample as migrated legacy data.
// Keep its payment, ticket, ownership and inventory; only restore the historical order model.
// This fixture conversion is restricted to isolated smoke databases and freshly created test events.
export async function prepareLegacyRefundFixture({
  databaseUrl,
  eventId,
  eventSlug,
  checkout,
  externalId,
  ticketStatus,
}) {
  assert.match(eventSlug, /^(accept|wait)-[a-z0-9]+-[a-z0-9]+$/);
  return withFixtureDatabase(databaseUrl, async (client) => {
    await client.query('begin');
    try {
      const { rows: eventRows } = await client.query(
        'select id, slug from events where id=$1 and slug=$2',
        [eventId, eventSlug],
      );
      assert.equal(eventRows.length, 1, 'Fixture event does not match this smoke run');
      const { rows: orderRows } = await client.query(
        'select * from orders where id=$1 and event_id=$2 for update',
        [checkout.order.id, eventId],
      );
      assert.equal(orderRows.length, 1, 'Fixture order is outside the test event');
      const order = orderRows[0];
      assert.equal(order.model_version, 2);
      assert.equal(order.quantity, 1);
      assert.equal(order.status, 'paid');
      assert.equal(order.amount, checkout.order.amount);
      assert.equal(order.currency, checkout.order.currency);
      assert.equal(order.registration_id, checkout.registration.id);
      assert.ok(order.purchaser_customer_user_id);
      assert.ok(!order.entitlements_on_hold && order.refund_execution_mode !== 'external_hold');
      const { rows: items } = await client.query(
        'select * from order_items where order_id=$1 for update',
        [order.id],
      );
      assert.equal(items.length, 1, 'Legacy fixture must have exactly one seat');
      const item = items[0];
      assert.equal(item.registration_id, checkout.registration.id);
      assert.equal(item.event_id, eventId);
      assert.equal(item.organization_id, order.organization_id);
      assert.equal(item.state, 'active');
      assert.equal(item.allocated_amount, order.amount);
      assert.equal(item.unit_price, order.amount);
      const { rows: registrations } = await client.query(
        'select * from registrations where id=$1 for update',
        [item.registration_id],
      );
      assert.equal(registrations.length, 1);
      const registration = registrations[0];
      assert.equal(registration.customer_user_id, order.purchaser_customer_user_id);
      assert.equal(registration.ticket_type_id, item.ticket_type_id);
      assert.equal(registration.event_id, eventId);
      assert.equal(registration.organization_id, order.organization_id);
      assert.equal(registration.superseded_at, null);
      assert.equal(registration.status, ticketStatus === 'used' ? 'checked_in' : 'confirmed');
      const { rows: tickets } = await client.query(
        'select * from tickets where registration_id=$1 for update',
        [registration.id],
      );
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].status, ticketStatus);
      assert.equal(tickets[0].event_id, eventId);
      assert.equal(tickets[0].ticket_type_id, item.ticket_type_id);
      const { rows: payments } = await client.query(
        'select * from payments where order_id=$1 for update',
        [order.id],
      );
      assert.equal(payments.length, 1, 'Legacy fixture has ambiguous payment history');
      const payment = payments[0];
      assert.equal(payment.provider, 'test-provider');
      assert.equal(payment.external_id, externalId);
      assert.equal(payment.status, 'succeeded');
      assert.ok(payment.succeeded_at);
      assert.equal(payment.id, order.settled_payment_id);
      assert.equal(payment.amount, order.amount);
      assert.equal(payment.currency, order.currency);
      for (const table of ['refunds', 'refund_requests']) {
        const { rows } = await client.query(`select id from ${table} where order_id=$1`, [
          order.id,
        ]);
        assert.equal(rows.length, 0, 'Rejected v2 refund changed the financial state');
      }
      const { rows: reservations } = await client.query(
        'select * from inventory_reservations where order_id=$1',
        [order.id],
      );
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].order_item_id, item.id);
      assert.equal(reservations[0].quantity, 1);
      assert.ok(reservations[0].converted_at && !reservations[0].released_at);
      const { rows: ticketTypes } = await client.query(
        'select sold from ticket_types where id=$1 for update',
        [item.ticket_type_id],
      );
      assert.equal(ticketTypes.length, 1);
      assert.ok(ticketTypes[0].sold >= 1);
      await client.query('update orders set model_version=1, registration_id=$2 where id=$1', [
        order.id,
        registration.id,
      ]);
      await client.query('update order_items set client_id=null where id=$1', [item.id]);
      await client.query('commit');
      return {
        orderId: order.id,
        itemId: item.id,
        registrationId: registration.id,
        paymentId: payment.id,
        ticketId: tickets[0].id,
        ticketTypeId: item.ticket_type_id,
        sold: ticketTypes[0].sold,
        ticketStatus,
        registrationStatus: registration.status,
        amount: order.amount,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

export async function assertLegacyRefundFixture({
  databaseUrl,
  fixture,
  refundedAmount,
  fullRefund,
}) {
  return withFixtureDatabase(databaseUrl, async (client) => {
    const { rows: refunds } = await client.query('select * from refunds where order_id=$1', [
      fixture.orderId,
    ]);
    assert.equal(refunds.length, 1, 'Legacy refund retry created multiple refunds');
    assert.equal(refunds[0].payment_id, fixture.paymentId);
    assert.equal(refunds[0].amount, refundedAmount);
    assert.equal(refunds[0].status, 'succeeded');
    const { rows } = await client.query(
      `select o.model_version, o.status as order_status, oi.state as item_state,
      r.status as registration_status, t.status as ticket_status, p.status as payment_status, tt.sold
      from orders o join order_items oi on oi.order_id=o.id
      join registrations r on r.id=oi.registration_id join tickets t on t.registration_id=r.id
      join payments p on p.id=o.settled_payment_id join ticket_types tt on tt.id=oi.ticket_type_id
      where o.id=$1`,
      [fixture.orderId],
    );
    assert.equal(rows.length, 1);
    const state = rows[0];
    assert.equal(state.model_version, 1);
    assert.equal(state.order_status, fullRefund ? 'refunded' : 'partially_refunded');
    assert.equal(state.item_state, fullRefund ? 'cancelled' : 'active');
    assert.equal(state.registration_status, fullRefund ? 'cancelled' : fixture.registrationStatus);
    assert.equal(state.ticket_status, fullRefund ? 'cancelled' : fixture.ticketStatus);
    assert.equal(state.payment_status, fullRefund ? 'refunded' : 'succeeded');
    assert.equal(
      state.sold,
      fixture.sold - (fullRefund ? 1 : 0),
      'Legacy refund changed inventory incorrectly',
    );
  });
}
