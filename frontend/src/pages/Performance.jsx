import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Empty } from '../components/ui';

export default function Performance() {
  const { can } = useAuth();
  const toast = useToast();
  const [cycles, setCycles] = useState(null);
  const [goals, setGoals] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [emps, setEmps] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({});
  const [reviewModal, setReviewModal] = useState(null);
  const [rForm, setRForm] = useState({});

  const load = async () => {
    try {
      const [c, g, r] = await Promise.all([api.get('/performance/cycles'), api.get('/performance/goals'), api.get('/performance/reviews')]);
      setCycles(c.data.data);
      setGoals(g.data.data);
      setReviews(r.data.data);
      if (can('performance.manage')) {
        api.get('/employees?limit=100').then(({ data }) => setEmps(data.data)).catch(() => {});
      }
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const addGoal = async () => {
    try {
      await api.post('/performance/goals', { ...form, employeeId: Number(form.employeeId), cycleId: cycles[0]?.id, weightage: Number(form.weightage || 0) });
      toast('Goal assigned');
      setAdding(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const submitManagerReview = async () => {
    try {
      await api.post(`/performance/reviews/${reviewModal.id}/manager-review`, {
        rating: Number(rForm.rating), comments: rForm.comments, finalRating: rForm.finalRating ? Number(rForm.finalRating) : undefined,
      });
      toast('Manager review submitted');
      setReviewModal(null);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!cycles || !goals || !reviews) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="spread mb">
        <div className="row wrap">
          {cycles.map((c) => (
            <span key={c.id} className="badge blue">{c.name} · {c.status}</span>
          ))}
        </div>
        {can('performance.manage') && <button className="btn sm" onClick={() => { setForm({}); setAdding(true); }}>+ Assign goal</button>}
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>Goals & KPIs</h3></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Goal</th><th className="num">Weight</th><th>Progress</th><th>Due</th></tr></thead>
              <tbody>
                {goals.length === 0 && <tr><td colSpan={5}><Empty text="No goals yet" /></td></tr>}
                {goals.map((g) => (
                  <tr key={g.id}>
                    <td><b>{g.first_name} {g.last_name}</b></td>
                    <td>{g.title}{g.kpi && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>KPI: {g.kpi}</div>}</td>
                    <td className="num">{g.weightage}%</td>
                    <td style={{ minWidth: 90 }}>
                      <div className="bar-track" style={{ height: 8 }}><div className="bar-fill" style={{ width: `${g.progress}%` }} /></div>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{g.progress}%</span>
                    </td>
                    <td>{g.due_date ? fmtDate(g.due_date) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Review cycle</h3></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Self</th><th>Manager</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {reviews.length === 0 && <tr><td colSpan={5}><Empty text="No reviews initiated" /></td></tr>}
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.first_name} {r.last_name}</b></td>
                    <td>{r.self_rating ?? '—'}</td>
                    <td>{r.final_rating ?? r.manager_rating ?? '—'}</td>
                    <td><StatusBadge value={r.status} labels={{
                      not_started: ['gray', 'Not started'], self_review: ['blue', 'Self done'],
                      manager_review: ['amber', 'Manager review'], completed: ['green', 'Completed'],
                    }} /></td>
                    <td className="actions">
                      {can('performance.review') && (
                        <button className="btn ghost sm" onClick={() => { setReviewModal(r); setRForm({ rating: r.manager_rating || '', comments: r.manager_comments || '' }); }}>Review</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {adding && (
        <Modal title="Assign goal" onClose={() => setAdding(false)} footer={
          <><button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn" onClick={addGoal}>Assign</button></>
        }>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name}` }))} />
          <TextField label="Goal title *" value={form.title} onChange={setF('title')} />
          <TextField label="KPI / measure" value={form.kpi} onChange={setF('kpi')} />
          <div className="form-grid">
            <TextField label="Weightage (%)" type="number" value={form.weightage} onChange={setF('weightage')} />
            <TextField label="Target" value={form.target} onChange={setF('target')} />
            <TextField label="Due date" type="date" value={form.due_date} onChange={setF('due_date')} />
          </div>
        </Modal>
      )}

      {reviewModal && (
        <Modal title={`Manager review — ${reviewModal.first_name} ${reviewModal.last_name}`} onClose={() => setReviewModal(null)} footer={
          <><button className="btn secondary" onClick={() => setReviewModal(null)}>Cancel</button><button className="btn" onClick={submitManagerReview}>Submit</button></>
        }>
          {reviewModal.self_comments && (
            <div className="info-box"><b>Self review ({reviewModal.self_rating ?? 'no rating'}):</b> {reviewModal.self_comments}</div>
          )}
          <TextField label="Manager rating (1-5)" type="number" value={rForm.rating} onChange={(v) => setRForm((f) => ({ ...f, rating: v }))} />
          <TextField label="Final / calibrated rating (optional)" type="number" value={rForm.finalRating} onChange={(v) => setRForm((f) => ({ ...f, finalRating: v }))} />
          <TextField label="Comments" value={rForm.comments} onChange={(v) => setRForm((f) => ({ ...f, comments: v }))} />
        </Modal>
      )}
    </div>
  );
}
