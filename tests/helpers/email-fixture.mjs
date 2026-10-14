import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// Delivery stays inside the temporary test database. No external email is sent.
export const testDeliveryOptions = {
  autoFlush: false,
  config: { APP_ORIGIN: 'https://academy.example.com', EMAIL_FROM: 'academy@example.com', RESEND_API_KEY: 'test-only-not-sent' },
  sendEmail: async () => {},
};

export async function confirmRegistration(database, request, registration) {
  assert.equal(registration.status, 201);
  const db = new DatabaseSync(database);
  let token;
  try {
    const row = db.prepare("SELECT payload FROM notification_outbox WHERE user_id=? AND channel='verify' ORDER BY id DESC LIMIT 1").get(registration.body.user.id);
    assert.ok(row, 'A confirmation email must be queued for the registered test user');
    token = /#token=([a-f0-9]{64})/.exec(JSON.parse(row.payload).text || '')?.[1];
    assert.ok(token, 'The test confirmation email must include its one-time link');
  } finally { db.close(); }
  const confirmed = await request('/api/email/verify', { token });
  assert.equal(confirmed.status, 200);
}
