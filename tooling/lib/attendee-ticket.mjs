import assert from 'node:assert/strict';

export function assertPaymentSummary(completion, expectedOrder) {
  assert.equal(completion.order?.id, expectedOrder.id, 'Payment confirmed a different order');
  assert.equal(completion.order?.status, 'paid', 'Payment did not complete the order');
  assert.equal(completion.order?.amount, expectedOrder.amount, 'Payment changed the order amount');
  assert.equal(completion.order?.currency, expectedOrder.currency, 'Payment changed the currency');
  assert.equal(completion.order?.modelVersion, 2, 'Expected the current order model');
  for (const field of ['ticket', 'tickets', 'items', 'registration', 'attendee', 'qrPayload']) {
    assert.equal(Object.hasOwn(completion, field), false, `Payment response exposed ${field}`);
    assert.equal(Object.hasOwn(completion.order, field), false, `Payment order exposed ${field}`);
  }
}

export async function readAttendeeTicket({ apiBase, registrationId, headers }) {
  assert.ok(headers?.Cookie, 'Reading an attendee ticket requires a signed-in attendee');
  const registrationResponse = await fetch(
    `${apiBase}/customer/registrations/${encodeURIComponent(registrationId)}`,
    { headers },
  );
  assert.equal(registrationResponse.status, 200, 'Attendee could not read their registration');
  const registration = await registrationResponse.json();
  assert.equal(registration.id, registrationId, 'Attendee registration identity changed');
  assert.ok(registration.ticketCode, 'Confirmed attendee has no ticket code');
  assert.ok(
    ['valid', 'used'].includes(registration.ticketStatus),
    'Attendee ticket is unavailable',
  );
  const ticketResponse = await fetch(
    `${apiBase}/tickets/${encodeURIComponent(registration.ticketCode)}`,
    { headers },
  );
  assert.equal(ticketResponse.status, 200, 'Attendee ticket could not be loaded');
  const ticket = await ticketResponse.json();
  assert.ok(ticket.id, 'Attendee ticket has no stable ID');
  assert.equal(ticket.code, registration.ticketCode, 'Attendee ticket code changed');
  assert.equal(ticket.registrationId, registrationId, 'Ticket belongs to another registration');
  assert.equal(ticket.status, registration.ticketStatus, 'Ticket and registration state disagree');
  return ticket;
}
