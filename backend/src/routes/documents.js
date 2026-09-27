const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { upload, relPath } = require('../middleware/upload');
const { generateLetterPdf } = require('../services/pdf');
const { getSetting } = require('../services/settings');

const r = express.Router();
r.use(authenticate);

const DOC_TYPES = ['offer_letter', 'appointment_letter', 'id_proof', 'qualification', 'certification', 'payslip_upload', 'other'];

// ---------- Employee documents ----------
r.get('/employee/:employeeId', requirePermission('document.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM employee_documents WHERE tenant_id = ? AND employee_id = ? ORDER BY created_at DESC', [req.user.tenant_id, req.params.employeeId]);
  res.json({ data: rows });
}));

r.post('/employee/:employeeId', requirePermission('document.view'), upload('documents'), asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'File required');
  const { docType, name, issuedOn, expiresOn } = req.body || {};
  const target = Number(req.params.employeeId);
  const isSelf = Number(req.user.employee_id) === target;
  const isUploader = req.user.permissions.includes('document.manage');
  if (!isSelf && !isUploader) throw new HttpError(403, 'Not allowed');
  const [ins] = await pool.query(
    `INSERT INTO employee_documents (tenant_id, employee_id, doc_type, name, file_path, mime_type, size_bytes, issued_on, expires_on, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, target, docType || 'other', name || req.file.originalname, relPath(req.file), req.file.mimetype, req.file.size, issuedOn || null, expiresOn || null, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/employee-docs/:id/verify', requirePermission('document.manage'), asyncH(async (req, res) => {
  const { status } = req.body || {};
  if (!['verified', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'Invalid status');
  await pool.query('UPDATE employee_documents SET verification_status = ? WHERE id = ? AND tenant_id = ?', [status, req.params.id, req.user.tenant_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'document.verify', entityType: 'employee_document', entityId: req.params.id, after: { status }, req });
  res.json({ ok: true });
}));

r.delete('/employee-docs/:id', requirePermission('document.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM employee_documents WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (rows[0]) {
    await pool.query('DELETE FROM employee_documents WHERE id = ?', [req.params.id]);
    const fs = require('fs'); const path = require('path');
    const env = require('../config/env');
    const p = path.join(env.uploadDir, rows[0].file_path);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
}));

// ---------- Company documents & policy acknowledgement ----------
r.get('/company', asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT id, title, category, description, file_path, version, requires_ack, published_at, created_at FROM company_documents WHERE tenant_id = ? ORDER BY created_at DESC', [req.user.tenant_id]);
  const [acks] = await pool.query('SELECT document_id FROM document_acknowledgements WHERE tenant_id = ? AND employee_id = ?', [req.user.tenant_id, req.user.employee_id]);
  const ackSet = new Set(acks.map((a) => a.document_id));
  res.json({ data: rows.map((x) => ({ ...x, acknowledged: ackSet.has(x.id) })) });
}));

r.post('/company', requirePermission('document.manage'), upload('documents'), asyncH(async (req, res) => {
  const { title, category, description, requiresAck, version } = req.body || {};
  if (!title) throw new HttpError(400, 'Title required');
  const [ins] = await pool.query(
    `INSERT INTO company_documents (tenant_id, title, category, description, file_path, version, requires_ack, published_at, created_by)
     VALUES (?,?,?,?,?,?,?,NOW(),?)`,
    [req.user.tenant_id, title, category || 'policy', description || null, req.file ? relPath(req.file) : null, version || '1.0', requiresAck === 'true' || requiresAck === true ? 1 : 0, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/company/:id/acknowledge', asyncH(async (req, res) => {
  await pool.query(
    'INSERT IGNORE INTO document_acknowledgements (tenant_id, document_id, employee_id) VALUES (?,?,?)',
    [req.user.tenant_id, req.params.id, req.user.employee_id]
  );
  res.json({ ok: true });
}));

// ---------- Letter generation ----------
r.post('/generate-letter', requirePermission('letter.generate'), asyncH(async (req, res) => {
  const { templateId, employeeId, fields } = req.body || {};
  const [tpl] = await pool.query('SELECT * FROM letter_templates WHERE id = ? AND tenant_id = ?', [templateId, req.user.tenant_id]);
  if (!tpl[0]) throw new HttpError(404, 'Template not found');
  const [emps] = await pool.query('SELECT * FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, req.user.tenant_id]);
  const emp = emps[0];
  if (!emp) throw new HttpError(404, 'Employee not found');
  const [comp] = await pool.query('SELECT * FROM companies WHERE tenant_id = ?', [req.user.tenant_id]);
  const [tt] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.user.tenant_id]);
  const extra = fields || {};
  const vars = {
    employeeName: `${emp.first_name} ${emp.last_name}`, employeeCode: emp.employee_code,
    designation: '', department: '', companyName: comp[0]?.legal_name || tt[0]?.name || '',
    today: dayjs().format('DD MMMM YYYY'), ctc: extra.ctc || '', joiningDate: emp.joined_on ? dayjs(emp.joined_on).format('DD MMMM YYYY') : '',
    ...extra,
  };
  if (emp.designation_id) {
    const [d] = await pool.query('SELECT name FROM designations WHERE id = ?', [emp.designation_id]);
    vars.designation = d[0]?.name || '';
  }
  if (emp.department_id) {
    const [d] = await pool.query('SELECT name FROM departments WHERE id = ?', [emp.department_id]);
    vars.department = d[0]?.name || '';
  }
  const render = (s) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  const content = render(tpl.body);
  const pdfPath = await generateLetterPdf({ tenantId: req.user.tenant_id, employeeName: vars.employeeName, title: render(tpl.subject || tpl.name), content });
  const [ins] = await pool.query(
    `INSERT INTO generated_letters (tenant_id, employee_id, template_id, ltype, title, content, pdf_path, generated_by) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, employeeId, templateId, tpl.ltype, render(tpl.subject || tpl.name), content, pdfPath, req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'letter.generate', entityType: 'letter', entityId: ins.insertId, after: { employeeId, templateId }, req });
  res.status(201).json({ data: { id: ins.insertId, pdfPath } });
}));

r.get('/letters/:employeeId', requirePermission('document.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT id, ltype, title, pdf_path, generated_at FROM generated_letters WHERE tenant_id = ? AND employee_id = ? ORDER BY generated_at DESC', [req.user.tenant_id, req.params.employeeId]);
  res.json({ data: rows });
}));

module.exports = r;
