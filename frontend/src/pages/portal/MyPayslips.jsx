import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate, MONTHS } from '../../api';
import { Spinner, useToast, Empty, downloadFile } from '../../components/ui';

export default function MyPayslips() {
  const toast = useToast();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get('/payroll/payslips?mine=1').then(({ data }) => setRows(data.data)).catch((e) => toast(errMsg(e), true));
  }, []); // eslint-disable-line

  if (!rows) return <Spinner />;

  return (
    <div className="grid c3">
      {rows.length === 0 && <div className="card" style={{ gridColumn: '1 / -1' }}><div className="card-b"><Empty icon="💰" text="No payslips published yet — they appear here once payroll is approved" /></div></div>}
      {rows.map((p) => (
        <div className="card" key={p.id}>
          <div className="card-b">
            <div className="spread">
              <h3 style={{ fontSize: 15 }}>{MONTHS[p.period_month - 1]} {p.period_year}</h3>
              <span className={'badge ' + (p.status === 'paid' ? 'green' : 'purple')}>{p.status}</span>
            </div>
            <p style={{ fontSize: 26, fontWeight: 750, margin: '8px 0 2px' }}>{money2(p.net_pay)}</p>
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Gross {money2(p.gross)} · Deductions {money2(p.total_deductions)}{p.pay_date ? ` · Paid ${fmtDate(p.pay_date)}` : ''}
            </p>
            {p.pdf_path && (
              <button className="btn secondary sm" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
                onClick={() => downloadFile(`/api/files/${p.pdf_path}`, `payslip-${p.employee_code}-${p.period_year}${String(p.period_month).padStart(2, '0')}.pdf`)}>
                ⬇ Download PDF
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
