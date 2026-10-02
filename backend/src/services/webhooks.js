/**
 * Webhook emitter (spec §9): signed deliveries with event IDs and retry/dead-letter handling.
 * Signature: HMAC-SHA256(secret, `${eventId}.${timestamp}.${rawBody}`) in X-Arthvex-Signature.
 */
const crypto = require('crypto');
const { pool } = require('../config/db');

const MAX_ATTEMPTS = 5;

function sign(secret, eventId, timestamp, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${eventId}.${timestamp}.${rawBody}`).digest('hex');
}

async function deliver(delivery, subscription) {
  const timestamp = Date.now();
  const raw = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    tenant: delivery.tenant_id,
    createdAt: delivery.created_at,
    data: typeof delivery.payload === 'string' ? JSON.parse(delivery.payload) : delivery.payload,
  });
  const signature = sign(subscription.secret, delivery.event_id, timestamp, raw);
  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arthvex-Event-Id': delivery.event_id,
        'X-Arthvex-Event-Type': delivery.event_type,
        'X-Arthvex-Timestamp': String(timestamp),
        'X-Arthvex-Signature': signature,
      },
      body: raw,
      signal: AbortSignal.timeout(10000),
    });
    const attempts = delivery.attempts + 1;
    if (res.ok) {
      await pool.query(
        `UPDATE webhook_deliveries SET status = 'success', attempts = ?, response_code = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?`,
        [attempts, res.status, delivery.id]
      );
      return 'success';
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const attempts = delivery.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await pool.query(
      `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?`,
      [
        dead ? 'dead' : 'pending',
        attempts,
        String(e.message).slice(0, 490),
        dead ? null : new Date(Date.now() + Math.min(2 ** attempts, 60) * 60 * 1000),
        delivery.id,
      ]
    );
    return dead ? 'dead' : 'retry_scheduled';
  }
}

/** Fire an event to all matching active subscriptions. Best-effort, never throws. */
async function emitEvent({ tenantId, eventType, payload }) {
  try {
    const [subs] = await pool.query(
      'SELECT * FROM webhook_subscriptions WHERE tenant_id = ? AND active = 1',
      [tenantId]
    );
    const results = [];
    for (const sub of subs) {
      const events = typeof sub.events === 'string' ? JSON.parse(sub.events) : (sub.events || []);
      if (!events.includes(eventType) && !events.includes('*')) continue;
      const eventId = `${eventType}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
      const [ins] = await pool.query(
        `INSERT INTO webhook_deliveries (tenant_id, subscription_id, event_id, event_type, payload, status, attempts)
         VALUES (?,?,?,?,?, 'pending', 0)`,
        [tenantId, sub.id, eventId, eventType, JSON.stringify(payload || {})]
      );
      const [rows] = await pool.query('SELECT * FROM webhook_deliveries WHERE id = ?', [ins.insertId]);
      const status = await deliver(rows[0], sub);
      results.push({ subscriptionId: sub.id, eventId, status });
    }
    return results;
  } catch (e) {
    console.error('[webhooks] emit failed:', eventType, e.message);
    return [];
  }
}

/** Retry due deliveries (call opportunistically from deliveries listing). */
async function retryDue(tenantId) {
  const [rows] = await pool.query(
    `SELECT d.*, s.url, s.secret FROM webhook_deliveries d
     JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.tenant_id = ? AND d.status = 'pending' AND d.attempts > 0
       AND (d.next_retry_at IS NULL OR d.next_retry_at <= NOW())
     LIMIT 10`,
    [tenantId]
  );
  for (const d of rows) {
    await deliver(d, { url: d.url, secret: d.secret });
  }
  return rows.length;
}

module.exports = { emitEvent, retryDue, sign, deliver };
