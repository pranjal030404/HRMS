import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';

export default function Tickets() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({});
  const [detail, setDetail] = useState(null);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');

  const load = async () => {
    try {
      const { data } = await api.get('/tickets');
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api.post('/tickets', form);
      toast('Ticket raised');
      setCreating(false);
      setForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const openDetail = async (t) => {
    try {
      const { data } = await api.get(`/tickets/${t.id}`);
      setDetail(data.data);
      setComments(data.comments);
    } catch (e) { toast(errMsg(e), true); }
  };

  const addComment = async (internal = false) => {
    if (!newComment.trim()) return;
    try {
      await api.post(`/tickets/${detail.id}/comment`, { comment: newComment, isInternal: internal });
      setNewComment('');
      openDetail(detail);
    } catch (e) { toast(errMsg(e), true); }
  };

  const setStatus = async (status) => {
    try {
      await api.post(`/tickets/${detail.id}/status`, { status });
      toast(`Ticket ${status}`);
      openDetail({ ...detail, status });
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <DataTable
        columns={[
          { key: 'ticket_no', label: 'Ticket' },
          { key: 'first_name', label: 'Raised by', render: (r) => `${r.first_name} ${r.last_name}` },
          { key: 'subject', label: 'Subject' },
          { key: 'category', label: 'Category' },
          { key: 'priority', label: 'Priority', render: (r) => <span className={'badge ' + ({ low: 'gray', medium: 'blue', high: 'amber', urgent: 'red' }[r.priority] || 'gray')}>{r.priority}</span> },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
        ]}
        rows={rows}
        emptyText="No tickets"
        toolbar={<button className="btn sm" onClick={() => setCreating(true)}>+ Raise ticket</button>}
        onRowClick={openDetail}
      />
      {creating && (
        <Modal title="Raise a request" onClose={() => setCreating(false)} footer={
          <><button className="btn secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn" onClick={create}>Submit</button></>
        }>
          <SelectField label="Category" value={form.category} onChange={setF('category')}
            options={['hr', 'payroll', 'it', 'admin', 'general'].map((v) => ({ value: v, label: v.toUpperCase() }))} />
          <TextField label="Subject *" value={form.subject} onChange={setF('subject')} />
          <TextField label="Description" value={form.description} onChange={setF('description')} />
          <SelectField label="Priority" value={form.priority} onChange={setF('priority')}
            options={['low', 'medium', 'high', 'urgent'].map((v) => ({ value: v, label: v }))} />
        </Modal>
      )}
      {detail && (
        <Modal wide title={`${detail.ticket_no} — ${detail.subject}`} onClose={() => setDetail(null)}>
          <div className="spread mb">
            <span><StatusBadge value={detail.status} /> <span className="badge gray">{detail.category}</span> <span className="badge gray">{detail.priority}</span></span>
            {can('ticket.handle') && (
              <div className="row">
                {['open', 'in_progress', 'resolved', 'closed'].filter((s) => s !== detail.status).map((s) => (
                  <button key={s} className="btn sm secondary" onClick={() => setStatus(s)}>{s.replace('_', ' ')}</button>
                ))}
              </div>
            )}
          </div>
          <p style={{ fontSize: 13.5 }}>{detail.description || <i>No description</i>}</p>
          <h4 style={{ fontSize: 13.5, margin: '16px 0 8px' }}>Conversation</h4>
          {comments.map((c) => (
            <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <b style={{ fontSize: 12.5 }}>{c.author_name}</b>
              {c.is_internal ? <span className="badge amber" style={{ marginLeft: 6 }}>internal note</span> : null}
              <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>{fmtDate(c.created_at, true)}</span>
              <p style={{ fontSize: 13 }}>{c.comment}</p>
            </div>
          ))}
          <div className="field" style={{ marginTop: 12 }}>
            <textarea rows={2} placeholder="Write a reply…" value={newComment} onChange={(e) => setNewComment(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => addComment(false)}>Reply</button>
            {can('ticket.handle') && <button className="btn sm secondary" onClick={() => addComment(true)}>Add internal note</button>}
          </div>
        </Modal>
      )}
    </>
  );
}
