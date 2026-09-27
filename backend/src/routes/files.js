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
  const isPlatform = req.user.role === 'platform_super_admin';
  const t = req.user.tenant_id;

  // resolve tenant ownership of the file
  let owns = false;
  switch (subdir) {
    case 'payslips': {
      if (perms.includes('payroll.view')) { owns = true; break; }
      const [rows] = await pool.query('SELECT employee_id FROM payslips WHERE pdf_path = ? AND tenant_id = ?', [`${subdir}/${file}`, t]);
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
    case 'announcements':
      owns = true;
      break;
    default:
      throw new HttpError(403, 'Not allowed');
  }
  if (isPlatform || owns) {
    res.setHeader('Content-Type', guessMime(file));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(file)}"`);
    res.sendFile(filePath);
  } else {
    throw new HttpError(403, 'Not allowed to access this file');
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
