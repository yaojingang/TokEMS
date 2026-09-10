import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in; the supplied server is used only to create an isolated disposable database.
const integration = process.env.BATCH_TEST_DATABASE_URL ? describe : describe.skip;
const migrationPath = new URL('../drizzle/0065_batch_ticket_foundation.sql', import.meta.url);

integration('batch-ticket foundation migration and transaction constraints', () => {
  const databaseName = `batch_foundation_${randomUUID().replaceAll('-', '')}`;
  const org = randomUUID();
  const otherOrg = randomUUID();
  const ticketType = randomUUID();
  const previousTicketType = randomUUID();
  const otherTicketType = randomUUID();
  const payment = randomUUID();
  const freePayment = randomUUID();
  const refundedPayment = randomUUID();
  const legacyRefund = randomUUID();
  const request = randomUUID();
  const uncertainRequest = randomUUID();
  const reservation = randomUUID();
  const oldReservation = randomUUID();
  const quantityReservation = randomUUID();
  let admin: pg.Pool;
  let db: pg.Pool;
  let created = false;
  let migration: string;
  let paid: { order: string; registration: string };
  let free: typeof paid;
  let ambiguous: typeof paid;
  let refunded: typeof paid;
  let mismatch: typeof paid;
  let batch: { order: string; items: string[]; registrations: string[] };
  let before: Record<string, unknown[]>;
  let rolledBackMigration = false;

  async function apply(sql: string, connection: pg.PoolClient) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await connection.query(statement);
    }
  }

  async function transaction(action: (connection: pg.PoolClient) => Promise<void>) {
    const connection = await db.connect();
    await connection.query('BEGIN');
    try {
      await action(connection);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async function rejects(sql: string, parameters: unknown[], constraint: string) {
    await expect(
      transaction(async (connection) => {
        await connection.query(sql, parameters);
      }),
    ).rejects.toMatchObject({ constraint });
  }

  async function registration(connection: pg.Pool | pg.PoolClient = db) {
    const id = randomUUID();
    await connection.query(
      `insert into registrations
      (id, organization_id, event_id, ticket_type_id, registration_code, attendee)
      values ($1::uuid, $2, 101, $3, $1::text, '{}')`,
      [id, org, ticketType],
    );
    return id;
  }

  async function legacyOrder(amount = 100, state = 'confirmed') {
    const registrationId = await registration();
    await db.query('update registrations set status = $2 where id = $1', [registrationId, state]);
    const id = randomUUID();
    await db.query(
      `insert into orders (id, organization_id, event_id, registration_id,
      order_no, amount, currency, pricing_snapshot, expires_at)
      values ($1::uuid, $2, 101, $3, $1::text, $4, 'CNY', '{"retainedLegacyEvidence":true}', now())`,
      [id, org, registrationId, amount],
    );
    return { order: id, registration: registrationId };
  }

  async function addPayment(id: string, order: string, amount: number, status = 'succeeded') {
    await db.query(
      `insert into payments (id, order_id, provider, channel, amount, currency, status)
      values ($1, $2, 'mock', $3, $4, 'CNY', $5)`,
      [id, order, amount === 0 ? 'free' : 'mock', amount, status],
    );
  }

  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const table of [
      'orders',
      'payments',
      'refund_requests',
      'refunds',
      'invoice_requests',
      'tickets',
      'inventory_reservations',
    ]) {
      const rows =
        await db.query(`select to_jsonb(t) - 'model_version' - 'quantity' - 'settled_payment_id'
        - 'entitlements_on_hold' - 'version' - 'protection_scope' - 'order_item_id' as data
        from ${table} t order by id`);
      result[table] = rows.rows.map((row) => row.data);
    }
    return result;
  }

  beforeAll(async () => {
    const url = new URL(process.env.BATCH_TEST_DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Batch migration tests require a loopback PostgreSQL server');
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`create database "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    db = new pg.Pool({ connectionString: url.toString() });
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    for (const previous of migrations.slice(0, 65)) {
      await transaction(async (connection) => {
        for (const statement of previous.sql)
          if (statement.trim()) await connection.query(statement);
      });
    }
    await db.query(
      `insert into organizations (id, slug, name) values ($1, 'batch-test', 'Batch'), ($2, 'other', 'Other')`,
      [org, otherOrg],
    );
    await db.query(
      `insert into events (id, organization_id, slug, name, short_name, tagline, description,
      starts_at, ends_at, timezone, venue, city, address) values
      (101, $1, 'batch', 'Batch', 'Batch', '', '', now(), now(), 'UTC', '', '', ''),
      (102, $2, 'other', 'Other', 'Other', '', '', now(), now(), 'UTC', '', '', '')`,
      [org, otherOrg],
    );
    await db.query(
      `insert into ticket_types (id, organization_id, event_id, code, name, description, price, capacity)
      values ($1, $2, 101, 'current', 'Current', '', 999, 100), ($3, $2, 101, 'old', 'Old', '', 888, 100),
      ($4, $5, 102, 'other', 'Other', '', 10, 100)`,
      [ticketType, org, previousTicketType, otherTicketType, otherOrg],
    );
    paid = await legacyOrder();
    free = await legacyOrder(0);
    ambiguous = await legacyOrder();
    refunded = await legacyOrder(100, 'cancelled');
    mismatch = await legacyOrder(100, 'pending_payment');
    await addPayment(payment, paid.order, 100);
    await addPayment(freePayment, free.order, 0);
    await addPayment(randomUUID(), ambiguous.order, 100);
    await addPayment(randomUUID(), ambiguous.order, 80);
    await addPayment(refundedPayment, refunded.order, 100, 'refunded');
    await addPayment(randomUUID(), mismatch.order, 80);
    await db.query(
      `insert into tickets (event_id, registration_id, ticket_type_id, code, status)
      values (101, $1, $2, 'keep-this-code', 'valid'), (101, $3, $2, 'keep-cancelled-code', 'cancelled')`,
      [paid.registration, ticketType, refunded.registration],
    );
    await db.query(
      `insert into inventory_reservations (id, event_id, ticket_type_id, order_id, quantity, expires_at, released_at)
      values ($1, 101, $2, $3, 1, now(), null), ($4, 101, $5, $3, 1, now(), now()), ($6, 101, $2, $3, 2, now(), now())`,
      [
        reservation,
        ticketType,
        paid.order,
        oldReservation,
        previousTicketType,
        quantityReservation,
      ],
    );
    await db.query(
      `insert into invoice_requests (request_no, organization_id, event_id, order_id, registration_id, amount, net_paid_amount)
      values ('preserved-invoice', $1, 101, $2, $3, 100, 100)`,
      [org, paid.order, paid.registration],
    );
    for (const [id, snapshotValue] of [
      [
        request,
        { registrationId: refunded.registration, ticketTypeId: ticketType, fullRefund: true },
      ],
      [uncertainRequest, {}],
    ] as const) {
      await db.query(
        `insert into refund_requests (id, organization_id, event_id, order_id, payment_id,
        source, amount, currency, reserved_amount, review_status, policy_snapshot, business_snapshot,
        idempotency_key, request_hash, terminated_at)
        values ($1::uuid, $2, 101, $3, $4, 'admin', 100, 'CNY', 0, 'approved', '{}', $5, $1::text, $1::text, now())`,
        [id, org, refunded.order, refundedPayment, snapshotValue],
      );
    }
    await db.query(
      `insert into refunds (id, organization_id, event_id, order_id, payment_id, request_id,
      refund_no, amount, currency, status, reason, idempotency_key)
      values ($1::uuid, $2, 101, $3, $4, $5, $1::text, 100, 'CNY', 'succeeded', 'Historical', $1::text)`,
      [legacyRefund, org, refunded.order, refundedPayment, request],
    );
    // A negative historical refund makes the payment's allocation history untrusted.
    for (const amount of [100, -1]) {
      const id = randomUUID();
      await db.query(
        `insert into refunds (id, organization_id, event_id, order_id, payment_id,
        refund_no, amount, currency, status, reason, idempotency_key)
        values ($1::uuid, $2, 101, $3, $4, $1::text, $5, 'CNY', 'succeeded', 'Untrusted history', $1::text)`,
        [id, org, paid.order, payment, amount],
      );
    }
    before = await snapshot();
    migration = await readFile(migrationPath, 'utf8');
    await expect(
      transaction(async (connection) => {
        await connection.query('update orders set amount = -1 where id = $1', [paid.order]);
        await apply(migration, connection);
      }),
    ).rejects.toMatchObject({ constraint: 'order_items_money_check' });
    rolledBackMigration =
      (await db.query("select to_regclass('order_items') as value")).rows[0].value === null;
    await transaction((connection) => apply(migration, connection));
  }, 90_000);

  afterAll(async () => {
    await db?.end();
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin?.end();
  });

  it('rolls back all schema and data changes when legacy validation fails', async () => {
    expect(rolledBackMigration).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('backfills exactly one stable item per legacy order from current trusted price and registration state', async () => {
    const items = (await db.query('select * from order_items order by order_id')).rows;
    expect(items).toHaveLength(5);
    expect(items.find((row) => row.order_id === paid.order)).toMatchObject({
      id: paid.order,
      registration_id: paid.registration,
      unit_price: 100,
      allocated_amount: 100,
      ticket_type_id: ticketType,
      position: 1,
      state: 'active',
      client_id: null,
      pricing_snapshot: { retainedLegacyEvidence: true },
      cancelled_at: null,
      inventory_released_at: null,
    });
    expect(items.find((row) => row.order_id === refunded.order).state).toBe('cancelled');
    expect(items.find((row) => row.order_id === mismatch.order).state).toBe('pending');
  });

  it('selects only a single matching successful payment, including free and refunded orders', async () => {
    const rows = (await db.query('select id, settled_payment_id from orders')).rows;
    const selected = (id: string) => rows.find((row) => row.id === id).settled_payment_id;
    expect(selected(paid.order)).toBe(payment);
    expect(selected(free.order)).toBe(freePayment);
    expect(selected(refunded.order)).toBe(refundedPayment);
    expect(selected(ambiguous.order)).toBeNull();
    expect(selected(mismatch.order)).toBeNull();
  });

  it('preserves historical other-ticket and multi-quantity reservation rows with null item pointers', async () => {
    const rows = (
      await db.query(
        'select id, ticket_type_id, quantity, order_item_id from inventory_reservations',
      )
    ).rows;
    expect(rows.find((row) => row.id === reservation).order_item_id).toBe(paid.order);
    expect(rows.find((row) => row.id === oldReservation)).toMatchObject({
      ticket_type_id: previousTicketType,
      order_item_id: null,
    });
    expect(rows.find((row) => row.id === quantityReservation)).toMatchObject({
      quantity: 2,
      order_item_id: null,
    });
  });

  it('maps only a scoped historical refund request and its trusted successful execution', async () => {
    expect((await db.query('select id, rights_effect from refund_request_items')).rows).toEqual([
      { id: request, rights_effect: 'revoke' },
    ]);
    expect(
      (
        await db.query(
          'select id, amount, basis, refund_request_item_id from refund_item_allocations',
        )
      ).rows,
    ).toEqual([
      {
        id: legacyRefund,
        amount: 100,
        basis: 'legacy_single_item_verified',
        refund_request_item_id: request,
      },
    ]);
  });

  it('can reapply the migration without changing old rows, item IDs or refund allocations', async () => {
    const items = (await db.query('select * from order_items order by id')).rows;
    const allocations = (await db.query('select * from refund_item_allocations order by id')).rows;
    await transaction((connection) => apply(migration, connection));
    expect(await snapshot()).toEqual(before);
    expect((await db.query('select * from order_items order by id')).rows).toEqual(items);
    expect((await db.query('select * from refund_item_allocations order by id')).rows).toEqual(
      allocations,
    );
  });

  it('accepts a complete two-person order and a null-registration order-level invoice in one transaction', async () => {
    batch = { order: randomUUID(), items: [randomUUID(), randomUUID()], registrations: [] };
    await transaction(async (connection) => {
      for (let i = 0; i < 2; i++) batch.registrations.push(await registration(connection));
      await connection.query(
        `insert into orders (id, organization_id, event_id, model_version, quantity,
        purchase_intent_id, order_no, amount, currency, pricing_snapshot, expires_at)
        values ($1::uuid, $2, 101, 2, 2, $3, $1::text, 200, 'CNY', '{}', now())`,
        [batch.order, org, randomUUID()],
      );
      for (let i = 0; i < 2; i++) {
        await connection.query(
          `insert into order_items (id, order_id, registration_id, organization_id, event_id,
          client_id, position, ticket_type_id, unit_price, allocated_amount, pricing_snapshot)
          values ($1, $2, $3, $4, 101, $5, $6, $7, 100, 100, '{}')`,
          [
            batch.items[i],
            batch.order,
            batch.registrations[i],
            org,
            randomUUID(),
            i + 1,
            ticketType,
          ],
        );
      }
      await connection.query(
        `insert into invoice_requests (request_no, organization_id, event_id, order_id, amount, net_paid_amount)
        values ('batch-invoice', $1, 101, $2, 200, 200)`,
        [org, batch.order],
      );
    });
    expect(
      (await db.query('select registration_id from orders where id = $1', [batch.order])).rows[0]
        .registration_id,
    ).toBeNull();
  });

  it.each(['amount', 'quantity'])(
    'rejects committed model2 %s drift against its items',
    async (column) => {
      await rejects(
        `update orders set ${column} = ${column} + 1 where id = $1`,
        [batch.order],
        'orders_items_totals_match',
      );
    },
  );

  it('rejects deletion of a model2 item at commit', async () => {
    await rejects(
      'delete from order_items where id = $1',
      [batch.items[0]],
      'orders_items_totals_match',
    );
  });

  it('rejects changing a legacy compatibility registration away from its item', async () => {
    const different = await registration();
    await rejects(
      'update orders set registration_id = $2 where id = $1',
      [mismatch.order, different],
      'orders_registration_item_match',
    );
  });

  it.each([
    ['model_version = 3', 'orders_model_shape_check'],
    ['model_version = 2, purchase_intent_id = null', 'orders_model_shape_check'],
    ['registration_id = null', 'orders_model_shape_check'],
    ['quantity = 21', 'orders_model_shape_check'],
    ['version = 0', 'orders_version_check'],
  ])('rejects invalid order shape: %s', async (assignment, constraint) => {
    await rejects(`update orders set ${assignment} where id = $1`, [paid.order], constraint);
  });

  it.each([
    ['unit_price = -1', 'order_items_money_check'],
    ['allocated_amount = -1', 'order_items_money_check'],
    ['position = 0', 'order_items_position_check'],
    ["state = 'unknown'", 'order_items_state_check'],
  ])('rejects invalid item shape: %s', async (assignment, constraint) => {
    await rejects(`update order_items set ${assignment} where id = $1`, [paid.order], constraint);
  });

  it('rejects a settled payment belonging to another order', async () => {
    await rejects(
      'update orders set settled_payment_id = $2 where id = $1',
      [free.order, payment],
      'orders_settled_payment_scope_fk',
    );
  });

  it('rejects an item ticket type from another organization and event', async () => {
    await rejects(
      'update order_items set ticket_type_id = $2 where id = $1',
      [free.order, otherTicketType],
      'order_items_ticket_scope_fk',
    );
  });

  it('rejects a wrong original ticket reservation association and non-unit item quantity', async () => {
    await rejects(
      'update inventory_reservations set order_item_id = $2 where id = $1',
      [oldReservation, paid.order],
      'inventory_reservations_item_scope_fk',
    );
    await rejects(
      'update inventory_reservations set quantity = 2 where id = $1',
      [reservation],
      'inventory_reservations_item_quantity_check',
    );
  });

  it('keeps order-level invoice scope protection when registration is null', async () => {
    await rejects(
      'update invoice_requests set event_id = 102 where order_id = $1',
      [batch.order],
      'invoice_requests_order_scope_fk',
    );
    await rejects(
      'update invoice_requests set registration_id = $2 where order_id = $1',
      [batch.order, paid.registration],
      'invoice_requests_registration_item_scope_fk',
    );
  });

  it('rejects cross-payment and cross-item refund mappings', async () => {
    await rejects(
      `insert into refund_request_items (refund_request_id, payment_id, order_id, order_item_id, organization_id, event_id, requested_amount, rights_effect)
      values ($1, $2, $3, $3, $4, 101, 100, 'revoke')`,
      [uncertainRequest, payment, refunded.order, org],
      'refund_request_items_request_scope_fk',
    );
    await rejects(
      'update refund_item_allocations set payment_id = $2 where id = $1',
      [legacyRefund, payment],
      'refund_item_allocations_refund_scope_fk',
    );
    await rejects(
      'update refund_item_allocations set order_item_id = $2 where id = $1',
      [legacyRefund, paid.order],
      'refund_item_allocations_order_item_scope_fk',
    );
  });

  it('rejects a same-payment request item belonging to a different refund request', async () => {
    await rejects(
      'update refund_request_items set refund_request_id = $2 where id = $1',
      [request, uncertainRequest],
      'refund_allocations_request_match',
    );
  });

  it('accepts a model2 free single-person order with its own settled payment and rejects another payment', async () => {
    const orderId = randomUUID();
    const paymentId = randomUUID();
    await transaction(async (connection) => {
      const registrationId = await registration(connection);
      await connection.query(
        `insert into orders (id, organization_id, event_id, registration_id, model_version,
        quantity, purchase_intent_id, order_no, amount, currency, pricing_snapshot, expires_at)
        values ($1::uuid, $2, 101, $3, 2, 1, $4, $1::text, 0, 'CNY', '{}', now())`,
        [orderId, org, registrationId, randomUUID()],
      );
      await connection.query(
        `insert into order_items (order_id, registration_id, organization_id, event_id,
        position, ticket_type_id, unit_price, allocated_amount, pricing_snapshot)
        values ($1, $2, $3, 101, 1, $4, 0, 0, '{}')`,
        [orderId, registrationId, org, ticketType],
      );
      await connection.query(
        `insert into payments (id, order_id, provider, channel, status, amount, currency)
        values ($1, $2, 'free', 'free', 'succeeded', 0, 'CNY')`,
        [paymentId, orderId],
      );
      await connection.query('update orders set settled_payment_id = $2 where id = $1', [
        orderId,
        paymentId,
      ]);
    });
    expect(
      (await db.query('select settled_payment_id from orders where id = $1', [orderId])).rows[0]
        .settled_payment_id,
    ).toBe(paymentId);
    await rejects(
      'update orders set settled_payment_id = $2 where id = $1',
      [orderId, freePayment],
      'orders_settled_payment_scope_fk',
    );
  });

  it('allows a staged legacy single-person writer to commit before it creates an item', async () => {
    const legacy = await legacyOrder();
    expect(
      (
        await db.query(
          'select model_version, quantity, registration_id from orders where id = $1',
          [legacy.order],
        )
      ).rows[0],
    ).toMatchObject({ model_version: 1, quantity: 1, registration_id: legacy.registration });
    expect(
      (await db.query('select id from order_items where order_id = $1', [legacy.order])).rowCount,
    ).toBe(0);
  });

  it('preserves financial references on deletion', async () => {
    await rejects(
      'delete from payments where id = $1',
      [freePayment],
      'orders_settled_payment_scope_fk',
    );
    await rejects(
      'delete from order_items where id = $1',
      [refunded.order],
      'refund_item_allocations_order_item_scope_fk',
    );
  });
});
