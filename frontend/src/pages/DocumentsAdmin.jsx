import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast, Modal, TextField, SelectField, Empty, Tabs } from '../components/ui';

export default function DocumentsAdmin() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('generate');
  const [templates, setTemplates] = useState([]);
  const [emps, setEmps] = useState([]);
  const [companyDocs, setCompanyDocs] = useState([]);
  const [genForm, setGenForm] = useState({});
  const [uploadForm, setUploadForm] = useState({});
  const [generated, setGenerated] = useState(null);
  const fileRef = React.useRef(null);

  const load = async () => {
    try {
      const [t, e, d] = await Promise.all([
        api.get('/org/letter-templates'),
        can('employee.view') ? api.get('/employees?limit=100') : Promise.resolve({ data: { data: [] } }),
        api.get('/documents/company'),
      ]);
      setTemplates(t.data.data);
      setEmps(e.data.data);
      setCompanyDocs(d.data.data);
      if (t.data.data[0]) setGenForm((f) => ({ ...f, templateId: t.data.data[0].id }));
    } catch (e2) { toast(errMsg(e2), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const generate = async () => {
    try {
      const { data } = await api.post('/documents/generate-letter', { ...genForm, employeeId: Number(genForm.employeeId), templateId: Number(genForm.templateId) });
      setGenerated(data.data);
      toast('Letter generated as PDF');
    } catch (e) { toast(errMsg(e), true); }
  };

  const uploadDoc = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !uploadForm.title) return toast('Title and file required', true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', uploadForm.title);
    fd.append('category', uploadForm.category || 'policy');
    fd.append('requiresAck', uploadForm.requiresAck ? 'true' : 'false');
    try {
      await api.post('/documents/company', fd);
      toast('Company document published');
      setUploadForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'generate', label: 'Generate letters' },
        { key: 'company', label: 'Company documents & policies' },
      ]} />
      {tab === 'generate' && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Generate a letter</h3></div>
            <div className="card-b">
              <SelectField label="Template" value={genForm.templateId} onChange={(v) => setGenForm((f) => ({ ...f, templateId: v }))}
                options={templates.map((t) => ({ value: t.id, label: `${t.name} (${t.ltype})` }))} />
              <SelectField label="Employee" value={genForm.employeeId} onChange={(v) => setGenForm((f) => ({ ...f, employeeId: v }))}
                options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
              <TextField label="CTC (optional, for offer/increment letters)" value={genForm.ctc} onChange={(v) => setGenForm((f) => ({ ...f, ctc: v }))} />
              <button className="btn" onClick={generate} disabled={!genForm.templateId || !genForm.employeeId}>Generate PDF</button>
              {generated && (
                <div className="info-box" style={{ marginTop: 14 }}>
                  Letter generated. <a href={`/api/files/${generated.pdfPath}`} target="_blank" rel="noreferrer">Open PDF →</a>
                </div>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Templates</h3></div>
            <div className="card-b">
              {templates.length === 0 && <Empty text="No templates — create them under Organization → Letter templates" />}
              {templates.map((t) => (
                <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <b style={{ fontSize: 13.5 }}>{t.name}</b> <span className="badge gray">{t.ltype}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'company' && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Publish document / policy</h3></div>
            <div className="card-b">
              <TextField label="Title *" value={uploadForm.title} onChange={(v) => setUploadForm((f) => ({ ...f, title: v }))} />
              <SelectField label="Category" value={uploadForm.category} onChange={(v) => setUploadForm((f) => ({ ...f, category: v }))}
                options={['policy', 'handbook', 'circular', 'benefit'].map((v) => ({ value: v, label: v }))} />
              <label className="check" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={!!uploadForm.requiresAck} onChange={(e) => setUploadForm((f) => ({ ...f, requiresAck: e.target.checked }))} />
                Require employee acknowledgement
              </label>
              <div className="field">
                <label>File (PDF preferred)</label>
                <input type="file" ref={fileRef} />
              </div>
              <button className="btn" onClick={uploadDoc}>Publish</button>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Published documents</h3></div>
            <div className="card-b">
              {companyDocs.length === 0 && <Empty text="Nothing published yet" />}
              {companyDocs.map((d) => (
                <div className="spread" key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <b style={{ fontSize: 13.5 }}>{d.title}</b> {d.requires_ack ? <span className="badge amber">ack required</span> : null}
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.category} · v{d.version} · {fmtDate(d.published_at)}</div>
                  </div>
                  {d.file_path && <a className="btn ghost sm" href={`/api/files/${d.file_path}`} target="_blank" rel="noreferrer">View</a>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
