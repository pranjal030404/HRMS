import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate, MONTHS } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast, SelectField, TextField, downloadFile } from '../components/ui';

export default function Reports() {
  const { can } = useAuth();
  const toast = useToast();
  const [catalog, setCatalog] = useState(null);
  const [report, setReport] = useState('employee-master');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [data, setData] = useState(null);
  const [columns, setColumns] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/admin/catalog').then(({ data }) => { setCatalog(data.data); }).catch((e) => toast(errMsg(e), true));
  }, []); // eslint-disable-line

  const load = async () => {
    setBusy(true);
    try {
      const { data: d } = await api.get('/admin/data', { params: { report, year, month } });
      setData(d.data);
      setColumns(d.columns || []);
    } catch (e) { toast(errMsg(e), true); }
    setBusy(false);
  };
  useEffect(() => { if (catalog) load(); /* eslint-disable-next-line */ }, [report, year, month, catalog]);

  if (!catalog) return <Spinner />;

  return (
    <div>
      <div className="card mb">
        <div className="card-h">
          <h3>Report catalogue</h3>
          {can('report.export') && (
            <button className="btn sm secondary" onClick={() => downloadFile(`/api/admin/data?report=${report}&year=${year}&month=${month}&format=csv`, `${report}.csv`)}>
              ⬇ Export CSV
            </button>
          )}
        </div>
        <div className="card-b">
          <div className="form-grid">
            <SelectField label="Report" value={report} onChange={setReport} options={catalog.map((r) => ({ value: r.key, label: r.name }))} />
            <div className="row">
              <SelectField label="Month (for monthly reports)" value={month} onChange={(v) => setMonth(Number(v))} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
              <SelectField label="Year" value={year} onChange={(v) => setYear(Number(v))} options={[new Date().getFullYear(), new Date().getFullYear() - 1].map((y) => ({ value: y, label: y }))} />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>{catalog.find((c) => c.key === report)?.name || report}</h3><span style={{ fontSize: 12, color: 'var(--muted)' }}>{data?.length ?? 0} rows</span></div>
        <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
          {busy ? <Spinner /> : (
            <table className="tbl">
              <thead><tr>{columns.map((c) => <th key={c}>{c.replace(/_/g, ' ').toUpperCase()}</th>)}</tr></thead>
              <tbody>
                {(data || []).map((row, i) => (
                  <tr key={i}>{columns.map((c) => <td key={c}>{typeof row[c] === 'number' && /amount|gross|net|salary|paid|emi|total|ctc/.test(c) ? money2(row[c]) : String(row[c] ?? '—')}</td>)}</tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
