const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const env = require('../config/env');
const { pool } = require('../config/db');
const { round2 } = require('../utils/helpers');

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inWords = require('../utils/numberToWords');

function ensure(sub) {
  const dir = path.join(env.uploadDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function text(doc, str, x, y, opts = {}) {
  doc.text(str || '', x, y, opts);
}

/** Employee payslip PDF. Returns relative path. */
async function generatePayslipPdf({ tenantId, item, run, payslipId }) {
  const [empRows] = await pool.query(
    `SELECT e.*, d.name AS dept_name, des.name AS desig_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id WHERE e.id = ?`,
    [item.employee_id]
  );
  const emp = empRows[0] || {};
  const [tRows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const tenant = tRows[0] || {};
  const earnings = Array.isArray(item.earnings) ? item.earnings : JSON.parse(item.earnings || '[]');
  const deductions = Array.isArray(item.deductions) ? item.deductions : JSON.parse(item.deductions || '[]');
  const period = `${dayjs().month(run.period_month - 1).format('MMMM')} ${run.period_year}`;

  const dir = ensure('payslips');
  const fileName = `payslip-${emp.employee_code || emp.id}-${run.period_year}${String(run.period_month).padStart(2, '0')}.pdf`;
  const filePath = path.join(dir, fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('error', reject);

    const brand = (typeof tenant.branding === 'string' ? JSON.parse(tenant.branding || '{}') : tenant.branding) || {};
    const primary = brand.primaryColor || '#1d4ed8';

    // header band
    doc.rect(40, 40, 515, 70).fill(primary);
    doc.fill('#ffffff').fontSize(18).font('Helvetica-Bold')
      .text(brand.companyName || tenant.name || 'Company', 56, 56);
    doc.fontSize(9).font('Helvetica')
      .text('Payslip for ' + period, 56, 80);

    // meta block
    let y = 130;
    doc.fill('#111111').font('Helvetica-Bold').fontSize(10).text(emp.first_name + ' ' + emp.last_name, 56, y);
    doc.font('Helvetica').fontSize(9).fill('#444444');
    y += 14; text(doc, `${emp.desig_name || ''}${emp.desig_name && emp.dept_name ? ' · ' : ''}${emp.dept_name || ''}`, 56, y);
    y += 13; text(doc, `Employee Code: ${emp.employee_code || '-'}   |   Pay Period: ${period}`, 56, y);
    y += 13; text(doc, `Joined: ${emp.joined_on ? dayjs(emp.joined_on).format('DD MMM YYYY') : '-'}   |   PAN: ${emp.pan_plain ? 'XXXXX' + String(emp.pan_plain).slice(-4) : 'Not provided'}`, 56, y);

    // days summary box
    doc.roundedRect(370, 126, 185, 70, 6).lineWidth(0.8).stroke('#dddddd');
    const days = [
      ['Payable Days', item.payable_days],
      ['LOP Days', item.lop_days],
      ['Month Days', item.month_days],
    ];
    let dy = 134;
    for (const [k, v] of days) {
      doc.fontSize(9).fill('#555555').text(k, 382, dy);
      doc.fill('#111111').text(String(v ?? '-'), 540, dy, { align: 'right', width: 0 });
      dy += 18;
    }

    // earnings / deductions table
    y = 220;
    const colW = 250;
    doc.fontSize(10).font('Helvetica-Bold').fill('#111111').text('Earnings', 56, y);
    doc.text('Deductions', 56 + colW + 40, y);
    y += 18;
    doc.moveTo(56, y).lineTo(56 + colW, y).moveTo(56 + colW + 40, y).lineTo(56 + colW * 2 + 40, y).strokeColor('#cccccc').stroke();
    y += 8;

    const maxRows = Math.max(earnings.length, deductions.length);
    const rowH = 16;
    doc.font('Helvetica').fontSize(9);
    for (let i = 0; i < maxRows; i++) {
      const e = earnings[i];
      const d = deductions[i];
      if (i % 2 === 0) doc.rect(52, y - 3, colW + 8, rowH).fill('#f6f7f9').rect(52 + colW + 36, y - 3, colW + 8, rowH).fill('#f6f7f9');
      doc.fill('#333333');
      if (e) {
        doc.text(e.name, 56, y, { width: colW - 80, ellipsis: true });
        doc.text(fmt(e.amount), 56 + colW - 70, y, { width: 66, align: 'right' });
      }
      if (d) {
        doc.text(d.name, 56 + colW + 40, y, { width: colW - 80, ellipsis: true });
        doc.text(fmt(d.amount), 56 + colW * 2 - 30, y, { width: 66, align: 'right' });
      }
      y += rowH;
    }

    // totals
    y += 6;
    doc.moveTo(56, y).lineTo(56 + colW * 2 + 40, y).strokeColor('#cccccc').stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fill('#111111');
    doc.text('Gross Earnings', 56, y);
    doc.text(fmt(item.gross), 56 + colW - 70, y, { width: 66, align: 'right' });
    doc.text('Total Deductions', 56 + colW + 40, y);
    doc.text(fmt(item.total_deductions), 56 + colW * 2 - 30, y, { width: 66, align: 'right' });
    y += 22;
    doc.roundedRect(52, y, 507, 30, 6).fill(primary);
    doc.fill('#ffffff').fontSize(11);
    doc.text('NET PAY', 68, y + 10);
    doc.text('Rs. ' + fmt(item.net_pay), 300, y + 10, { width: 245, align: 'right' });
    y += 40;
    doc.font('Helvetica').fontSize(8.5).fill('#555555');
    text(doc, `Amount in words: ${inWords(item.net_pay)} only`, 56, y);
    y += 22;
    const erContrib = Array.isArray(item.employer_contrib) ? item.employer_contrib : JSON.parse(item.employer_contrib || '[]');
    if (erContrib.length) {
      doc.font('Helvetica-Bold').fontSize(9).fill('#111111').text('Employer Contributions', 56, y);
      y += 14;
      doc.font('Helvetica').fontSize(9).fill('#333333');
      for (const c of erContrib) {
        doc.text(c.name, 56, y, { width: 160, ellipsis: true });
        doc.text(fmt(c.amount), 250, y, { align: 'right', width: 60 });
        y += rowH;
      }
      y += 6;
    }
    y += 26;
    doc.fontSize(7.5).fill('#888888');
    text(doc, 'This is a computer-generated payslip and does not require a signature. Amounts are in INR.', 56, y);
    text(doc, `Generated on ${dayjs().format('DD MMM YYYY, HH:mm')}`, 56, y + 12);

    doc.end();
    stream.on('finish', () => resolve(`payslips/${fileName}`));
  });
}

/** GST invoice PDF. */
async function generateInvoicePdf(tenantId, invoiceId) {
  const [invRows] = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.gstin, c.address, c.city, c.state, c.state_code
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.id = ? AND i.tenant_id = ?`, [invoiceId, tenantId]
  );
  const inv = invRows[0];
  if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  const [items] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
  const [tRows] = await pool.query('SELECT * FROM companies WHERE tenant_id = ?', [tenantId]);
  const [ttRows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const company = tRows[0] || {};
  const tenant = ttRows[0] || {};
  const brand = (typeof tenant.branding === 'string' ? JSON.parse(tenant.branding || '{}') : tenant.branding) || {};

  const dir = ensure('invoices');
  const fileName = `invoice-${inv.invoice_no}.pdf`;
  const filePath = path.join(dir, fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').fill('#111').text(brand.companyName || company.legal_name || tenant.name, 48, 48);
    doc.font('Helvetica').fontSize(8.5).fill('#555');
    let y = 70;
    const addr = [company.address_line1, company.address_line2, company.city, company.state, company.pincode].filter(Boolean).join(', ');
    text(doc, addr, 48, y, { width: 240 });
    y += 34;
    const taxIds = [company.gstin ? `GSTIN: ${company.gstin}` : '', company.pan ? `PAN: ${company.pan}` : ''].filter(Boolean).join('   |   ');
    text(doc, taxIds, 48, y);

    doc.fontSize(14).font('Helvetica-Bold').fill('#111').text('TAX INVOICE', 400, 48, { width: 110, align: 'right' });
    doc.font('Helvetica').fontSize(9).fill('#333');
    text(doc, `Invoice No: ${inv.invoice_no}`, 400, 72, { width: 110, align: 'right' });
    text(doc, `Date: ${dayjs(inv.invoice_date).format('DD MMM YYYY')}`, 400, 86, { width: 110, align: 'right' });
    text(doc, `Due: ${dayjs(inv.due_date).format('DD MMM YYYY')}`, 400, 100, { width: 110, align: 'right' });

    y = 130;
    doc.roundedRect(48, y, 500, 54, 4).lineWidth(0.7).stroke('#dddddd');
    doc.fontSize(8).fill('#777').text('BILL TO', 60, y + 8);
    doc.fontSize(10).font('Helvetica-Bold').fill('#111').text(inv.customer_name, 60, y + 20);
    doc.font('Helvetica').fontSize(8.5).fill('#555');
    text(doc, [inv.address, inv.city, inv.state, inv.pincode].filter(Boolean).join(', '), 60, y + 34, { width: 300 });
    doc.text(inv.gstin ? `GSTIN: ${inv.gstin}` : '', 330, y + 20, { width: 200, align: 'right' });
    doc.text(inv.state_code ? `Place of Supply: ${inv.state_code}` : '', 330, y + 34, { width: 200, align: 'right' });

    // items table
    y = 200;
    const cols = [
      { key: 'description', label: 'Description', x: 56, w: 220 },
      { key: 'hsn_sac', label: 'HSN/SAC', x: 280, w: 60 },
      { key: 'qty', label: 'Qty', x: 344, w: 36, align: 'right' },
      { key: 'rate', label: 'Rate', x: 384, w: 70, align: 'right' },
      { key: 'gst', label: 'GST', x: 458, w: 40, align: 'right' },
      { key: 'amount', label: 'Amount', x: 500, w: 44, align: 'right' },
    ];
    doc.rect(48, y, 500, 20).fill('#f1f3f6');
    doc.font('Helvetica-Bold').fontSize(8.5).fill('#333');
    for (const c of cols) doc.text(c.label, c.x, y + 6, { width: c.w, align: c.align || 'left' });
    y += 20;
    doc.font('Helvetica').fontSize(8.5);
    let iy = y;
    for (const it of items) {
      doc.fill('#222');
      doc.text(it.description, cols[0].x, iy, { width: cols[0].w, ellipsis: true });
      doc.text(it.hsn_sac || '-', cols[1].x, iy, { width: cols[1].w });
      doc.text(String(it.quantity), cols[2].x, iy, { width: cols[2].w, align: 'right' });
      doc.text(fmt(it.rate), cols[3].x, iy, { width: cols[3].w, align: 'right' });
      doc.text(`${it.gst_rate}%`, cols[4].x, iy, { width: cols[4].w, align: 'right' });
      doc.text(fmt(it.amount), cols[5].x, iy, { width: cols[5].w, align: 'right' });
      iy += 18;
      doc.moveTo(48, iy - 4).lineTo(548, iy - 4).strokeColor('#eeeeee').stroke();
    }
    y = iy + 6;
    doc.moveTo(48, y).lineTo(548, y).strokeColor('#cccccc').stroke();
    y += 10;
    const totals = [
      ['Subtotal', fmt(inv.subtotal)],
      ['Discount', fmt(inv.discount)],
      ...(inv.is_intra_state
        ? [['CGST', fmt(inv.cgst)], ['SGST', fmt(inv.sgst)]]
        : [['IGST', fmt(inv.igst)]]),
    ];
    doc.font('Helvetica').fontSize(9);
    for (const [k, v] of totals) {
      doc.fill('#444').text(k, 380, y, { width: 100, align: 'right' });
      doc.fill('#111').text(v, 486, y, { width: 60, align: 'right' });
      y += 15;
    }
    doc.rect(370, y, 178, 24).fill('#111');
    doc.fill('#fff').font('Helvetica-Bold').fontSize(10).text('TOTAL', 380, y + 7, { width: 100, align: 'right' });
    doc.text('Rs. ' + fmt(inv.total), 486, y + 7, { width: 60, align: 'right' });
    y += 40;
    doc.font('Helvetica').fontSize(8).fill('#666');
    text(doc, `Amount in words: ${inWords(inv.total)} only`, 48, y);
    if (inv.notes) text(doc, `Notes: ${inv.notes}`, 48, y + 14);
    y += 40;
    doc.fontSize(7.5).fill('#999');
    text(doc, 'This is a computer-generated invoice. Subject to applicable GST law.', 48, y);

    doc.end();
    stream.on('finish', async () => {
      await pool.query('UPDATE invoices SET pdf_path = ? WHERE id = ?', [`invoices/${fileName}`, invoiceId]);
      resolve(`invoices/${fileName}`);
    });
  });
}

/** Letter PDF from rendered text content. */
async function generateLetterPdf({ tenantId, employeeName, title, content }) {
  const dir = ensure('letters');
  const fileName = `letter-${Date.now()}.pdf`;
  const filePath = path.join(dir, fileName);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('error', reject);
    doc.fontSize(12).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica').text(String(content || ''), { align: 'left', lineGap: 4 });
    doc.end();
    stream.on('finish', () => resolve(`letters/${fileName}`));
  });
}

module.exports = { generatePayslipPdf, generateInvoicePdf, generateLetterPdf };
