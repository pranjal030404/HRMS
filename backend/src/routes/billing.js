const express = require('express');
const dayjs = require('dayjs');
const { pool, withTransaction } = require('../config/db');
const { asyncH, HttpError, round2 } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { generateInvoicePdf } = require('../services/pdf');
const { toCsv } = require('../utils/csv');

const r = express.Router();
r.use(authenticate);

// ---------- Invoices ----------
r.get('/invoices', requirePermission('billing.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'i.tenant_id = ?';
  if (req.query.status) { where += ' AND i.status = ?'; params.push(req.query.status); }
  if (req.query.customer_id) { where += ' AND i.customer_id = ?'; params.push(req.query.customer_id); }
  const [rows] = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.gstin FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE ${where} ORDER BY i.invoice_date DESC, i.id DESC LIMIT 300`,
    params
  );
  // refresh overdue flags
  const today = dayjs().format('YYYY-MM-DD');
  for (const inv of rows) {
    if (['sent', 'part_paid'].includes(inv.status) && inv.due_date < today) {
      await pool.query('UPDATE invoices SET status = "overdue" WHERE id = ?', [inv.id]);
      inv.status = 'overdue';
    }
  }
  res.json({ data: rows });
}));

r.get('/invoices/:id', requirePermission('billing.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.gstin, c.address, c.city, c.state, c.state_code, c.pincode
     FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ? AND i.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const inv = rows[0];
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const [items] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [req.params.id]);
  const [payments] = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on DESC', [req.params.id]);
  res.json({ data: inv, items, payments });
}));

/** Create invoice — totals & GST always recomputed server-side. */
r.post('/invoices', requirePermission('billing.manage'), asyncH(async (req, res) => {
  const { customerId, invoiceDate, notes, items, discount } = req.body || {};
  if (!customerId || !Array.isArray(items) || !items.length) throw new HttpError(400, 'customerId and items[] required');
  const [custs] = await pool.query('SELECT * FROM customers WHERE id = ? AND tenant_id = ?', [customerId, req.user.tenant_id]);
  const cust = custs[0];
  if (!cust) throw new HttpError(404, 'Customer not found');
  const [comp] = await pool.query('SELECT * FROM companies WHERE tenant_id = ?', [req.user.tenant_id]);
  const supplierState = comp[0]?.state_code || 'MH';

  let subtotal = 0;
  let cgst = 0, sgst = 0, igst = 0;
  const isIntra = cust.state_code === supplierState;
  const lineItems = items.map((it) => {
    const qty = Number(it.quantity || 1);
    const rate = Number(it.rate || 0);
    const amount = round2(qty * rate);
    subtotal += amount;
    const gstRate = Number(it.gstRate ?? 18);
    const tax = round2((amount * gstRate) / 100);
    if (isIntra) { cgst += round2(tax / 2); sgst += round2(tax / 2); } else { igst += tax; }
    return { description: String(it.description || 'Services'), hsn_sac: it.hsnSac || null, quantity: qty, rate, gst_rate: gstRate, amount };
  });
  subtotal = round2(subtotal);
  const disc = round2(discount || 0);
  const total = round2(subtotal - disc + cgst + sgst + igst);

  // invoice numbering per tenant per FY
  const fy = dayjs(invoiceDate || undefined).month() >= 3 ? dayjs(invoiceDate || undefined).year() : dayjs(invoiceDate || undefined).year() - 1;
  const prefix = `INV-${fy}${String((fy + 1) % 100).padStart(2, '0')}-`;
  const [[{ n }]] = await pool.query('SELECT COUNT(*)+1 AS n FROM invoices WHERE tenant_id = ? AND invoice_no LIKE ?', [req.user.tenant_id, `${prefix}%`]);
  const invoiceNo = `${prefix}${String(n).padStart(4, '0')}`;
  const terms = cust.payment_terms_days || 30;
  const dueDate = dayjs(invoiceDate || undefined).add(terms, 'day').format('YYYY-MM-DD');

  await withTransaction(async (conn) => {
    const [ins] = await conn.query(
      `INSERT INTO invoices (tenant_id, customer_id, invoice_no, invoice_date, due_date, subtotal, discount, cgst, sgst, igst, total, place_of_supply, is_intra_state, notes, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      [req.user.tenant_id, customerId, invoiceNo, invoiceDate || dayjs().format('YYYY-MM-DD'), dueDate, subtotal, disc, round2(cgst), round2(sgst), round2(igst), total, cust.state_code, isIntra ? 1 : 0, notes || null, req.user.id]
    );
    for (const li of lineItems) {
      await conn.query(
        'INSERT INTO invoice_items (invoice_id, description, hsn_sac, quantity, rate, gst_rate, amount) VALUES (?,?,?,?,?,?,?)',
        [ins.insertId, li.description, li.hsn_sac, li.quantity, li.rate, li.gst_rate, li.amount]
      );
    }
    return ins.insertId;
  }).then((id) => {
    logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'invoice.create', entityType: 'invoice', entityId: id, after: { invoiceNo, total }, req });
    res.status(201).json({ data: { id, invoiceNo, subtotal, cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), total } });
  });
}));

r.post('/invoices/:id/status', requirePermission('billing.manage'), asyncH(async (req, res) => {
  const { status } = req.body || {};
  if (!['draft', 'sent', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid status transition');
  await pool.query('UPDATE invoices SET status = ? WHERE id = ? AND tenant_id = ?', [status, req.params.id, req.user.tenant_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `invoice.${status}`, entityType: 'invoice', entityId: req.params.id, req });
  res.json({ ok: true });
}));

r.post('/invoices/:id/payments', requirePermission('billing.manage'), asyncH(async (req, res) => {
  const { amount, paidOn, mode, reference, notes } = req.body || {};
  if (!amount || Number(amount) <= 0) throw new HttpError(400, 'Amount required');
  const [rows] = await pool.query('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const inv = rows[0];
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (['cancelled', 'draft'].includes(inv.status)) throw new HttpError(400, `Cannot record payment on ${inv.status} invoice`);
  const paid = round2(Number(inv.amount_paid) + Number(amount));
  await pool.query('INSERT INTO invoice_payments (tenant_id, invoice_id, amount, paid_on, mode, reference, notes, recorded_by) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.tenant_id, inv.id, round2(amount), paidOn || dayjs().format('YYYY-MM-DD'), mode || 'bank_transfer', reference || null, notes || null, req.user.id]);
  const status = paid >= Number(inv.total) ? 'paid' : 'part_paid';
  await pool.query('UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?', [paid, status, inv.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'invoice.payment', entityType: 'invoice', entityId: inv.id, after: { amount, status }, req });
  res.status(201).json({ ok: true, status, amountPaid: paid });
}));

r.get('/invoices/:id/pdf', requirePermission('billing.view'), asyncH(async (req, res) => {
  const pdfPath = await generateInvoicePdf(req.user.tenant_id, req.params.id);
  const path = require('path');
  const env = require('../config/env');
  res.download(path.join(env.uploadDir, pdfPath));
}));

r.get('/summary', requirePermission('billing.view'), asyncH(async (req, res) => {
  const [billed] = await pool.query(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE tenant_id = ? AND status != 'cancelled'`, [req.user.tenant_id]);
  const [collected] = await pool.query(`SELECT COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE tenant_id = ? AND status != 'cancelled'`, [req.user.tenant_id]);
  const [gst] = await pool.query(`SELECT COALESCE(SUM(cgst+sgst),0) AS intra, COALESCE(SUM(igst),0) AS inter FROM invoices WHERE tenant_id = ? AND status != 'cancelled'`, [req.user.tenant_id]);
  const [aging] = await pool.query(
    `SELECT CASE
       WHEN due_date >= CURDATE() THEN 'current'
       WHEN due_date >= CURDATE() - INTERVAL 30 DAY THEN 'd30'
       WHEN due_date >= CURDATE() - INTERVAL 60 DAY THEN 'd60'
       ELSE 'd90+' END AS bucket,
       COALESCE(SUM(total - amount_paid),0) AS outstanding, COUNT(*) AS n
     FROM invoices WHERE tenant_id = ? AND status IN ('sent','part_paid','overdue') GROUP BY bucket`,
    [req.user.tenant_id]
  );
  res.json({
    data: {
      billed: billed[0].v, collected: collected[0].v, outstanding: round2(billed[0].v - collected[0].v),
      gst: { intra: gst[0].intra, inter: gst[0].inter }, aging,
    },
  });
}));

module.exports = r;
