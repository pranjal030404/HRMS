import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { Spinner, useToast, Empty } from '../../components/ui';

export default function MyDocuments() {
  const toast = useToast();
  const [docs, setDocs] = useState(null);
  const [letters, setLetters] = useState([]);
  const fileRef = React.useRef(null);
  const [form, setForm] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const me = (await api.get('/auth/me')).data.data;
        const [cd, lt] = await Promise.all([
          api.get('/documents/company'),
          api.get(`/documents/letters/${me.employeeId}`).catch(() => ({ data: { data: [] } })),
        ]);
        setDocs(cd.data.data);
        setLetters(lt.data.data);
      } catch (e) { toast(errMsg(e), true); setDocs([]); }
    })();
  }, []); // eslint-disable-line

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast('Choose a file', true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('docType', form.docType || 'other');
    fd.append('name', form.name || file.name);
    try {
      const me = (await api.get('/auth/me')).data.data;
      await api.post(`/documents/employee/${me.employeeId}`, fd);
      toast('Document uploaded for HR verification');
      setForm({});
    } catch (e) { toast(errMsg(e), true); }
  };

  const ack = async (id) => {
    try {
      await api.post(`/documents/company/${id}/acknowledge`);
      toast('Acknowledged');
      setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, acknowledged: true } : d)));
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!docs) return <Spinner />;

  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-h"><h3>Company policies & documents</h3></div>
        <div className="card-b">
          {docs.length === 0 && <Empty text="No company documents published" />}
          {docs.map((d) => (
            <div className="spread" key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <b style={{ fontSize: 13.5 }}>{d.title}</b>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.category} · v{d.version}{d.description ? ` · ${d.description}` : ''}</div>
              </div>
              <div className="row">
                {d.file_path && <a className="btn ghost sm" href={`/api/files/${d.file_path}`} target="_blank" rel="noreferrer">View</a>}
                {d.requires_ack && !d.acknowledged && <button className="btn sm" onClick={() => ack(d.id)}>Acknowledge</button>}
                {d.requires_ack && d.acknowledged && <span className="badge green">✓ Acknowledged</span>}
              </div>
            </div>
          ))}
          <h4 style={{ fontSize: 13, margin: '16px 0 8px' }}>Upload a document (ID proof etc.)</h4>
          <div className="form-grid">
            <select className="btn sm secondary" value={form.docType || 'id_proof'} onChange={(e) => setForm((f) => ({ ...f, docType: e.target.value }))}>
              {['id_proof', 'qualification', 'certification', 'other'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <input type="file" ref={fileRef} style={{ fontSize: 13 }} />
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={upload}>Upload</button>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h3>My letters</h3></div>
        <div className="card-b">
          {letters.length === 0 && <Empty text="No letters generated for you yet" />}
          {letters.map((l) => (
            <div className="spread" key={l.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div><b style={{ fontSize: 13.5 }}>{l.title}</b><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtDate(l.generated_at, true)}</div></div>
              <a className="btn ghost sm" href={`/api/files/${l.pdf_path}`} target="_blank" rel="noreferrer">PDF</a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
