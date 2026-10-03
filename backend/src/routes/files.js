const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/db');
const env = require('../config/env');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');

const r = express.Router();

/**
 * Protected file download. Every file sits in uploads/<subdir>/<file>; access is
 * re-authorized per request — the URL alone grants nothing.
 */
r.get('/:subdir/:file', authenticate, asyncH(async (req, res) => {
  const { subdir, file } = req.params;
  if (!/^[a-z-]+$/.test(subdir) || file.includes('..')) throw new HttpError(400, 'Invalid path');
  const filePath = path.join(env.uploadDir, subdir, file);
  if (!fs.existsSync(filePath)) throw new HttpError(404, 'File not found');

  const perms = req.user.permissions || [];
  const isPlatform = !!req.user.isPlatformAdmin;
  const rel = `${subdir}/${file}`;

  // Which company owns this file? The referencing row is the only record, so the
  // answer comes from the database and never from the request (spec §24: file
  // access respects tenant boundaries). A valid role is not enough — Company A's
  // owner holding `document.manage` must not be able to open Company B's upload.
  const OWNER_SQL = {
    payslips: ['SELECT tenant_id FROM payslips WHERE pdf_path = ?'],
    letters: ['SELECT tenant_id FROM generated_letters WHERE pdf_path = ?'],
    invoices: ['SELECT tenant_id FROM invoices WHERE pdf_path = ?'],
    documents: [
      'SELECT tenant_id FROM company_documents WHERE file_path = ?',
      'SELECT tenant_id FROM employee_documents WHERE file_path = ?',
    ],
    receipts: ['SELECT tenant_id FROM expense_claims WHERE receipt_path = ?'],
    resumes: ['SELECT tenant_id FROM candidates WHERE resume_path = ?'],
    // Previously served to any signed-in user. Ownership is now proved from the row that
    // references the file; an unreferenced photo/logo/announcement is not served.
    photos: ['SELECT tenant_id FROM employees WHERE profile_photo = ?'],
    logos: ["SELECT id AS tenant_id FROM tenants WHERE JSON_UNQUOTE(JSON_EXTRACT(branding, '$.logoUrl')) LIKE CONCAT('%', ?)"],
    announcements: [],
  };
  let ownerTenant = null;
  for (const sql of OWNER_SQL[subdir] || []) {
    const [rows] = await pool.query(`${sql} LIMIT 1`, [rel]);
    if (rows[0]) { ownerTenant = Number(rows[0].tenant_id); break; }
  }
  {
    if (!OWNER_SQL[subdir]) throw new HttpError(403, 'Not allowed');
    // An unreferenced file belongs to nobody we can prove; do not serve it.
    if (ownerTenant === null) throw new HttpError(404, 'File not found');
    if (Number(req.user.tenant_id) !== ownerTenant) {
      if (!isPlatform) throw new HttpError(404, 'File not found');
      // Platform staff reach another company's files only inside a support session.
      const reach = await require('../services/supportAccess').assertTenantReach(req.user, ownerTenant);
      require('../services/supportAccess').logAction(reach.session, {
        userId: req.user.id, action: 'GET file', method: 'GET', path: req.originalUrl, req,
      });
      return sendIt();
    }
  }

  let owns = false;
  switch (subdir) {
    case 'payslips': {
      if (perms.includes('payroll.view')) { owns = true; break; }
      const [rows] = await pool.query('SELECT employee_id FROM payslips WHERE pdf_path = ? AND tenant_id = ?', [rel, req.user.tenant_id]);
      owns = !!rows[0] && Number(rows[0].employee_id) === Number(req.user.employee_id);
      break;
    }
    case 'letters':
      owns = perms.includes('document.view:company') || perms.includes('document.view:own');
      break;
    case 'invoices':
      owns = perms.includes('billing.view');
      break;
    case 'documents':
      owns = perms.includes('document.manage') || perms.includes('document.view:company') || perms.includes('document.view:own');
      break;
    case 'receipts':
      owns = perms.includes('expense.view:company') || perms.includes('expense.view:own') || perms.includes('expense.view:team');
      break;
    case 'resumes':
      owns = perms.includes('recruitment.view');
      break;
    case 'photos':
    case 'logos':
      owns = true; // tenant ownership was already proved above
      break;
    default:
      throw new HttpError(403, 'Not allowed');
  }
  if (!owns) throw new HttpError(403, 'Not allowed to access this file');
  return sendIt();

  function sendIt() {
    res.setHeader('Content-Type', guessMime(file));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(file)}"`);
    res.sendFile(filePath);
  }
}));

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv', '.txt': 'text/plain',
  }[ext] || 'application/octet-stream';
}

module.exports = r;
