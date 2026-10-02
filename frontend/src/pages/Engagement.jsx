import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty, BarList } from '../components/ui';

export default function Engagement() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('recognition');
  const [overview, setOverview] = useState(null);
  const [mySurveys, setMySurveys] = useState([]);
  const [allSurveys, setAllSurveys] = useState([]);
  const [results, setResults] = useState(null);
  const [polls, setPolls] = useState([]);
  const [recognitions, setRecognitions] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [emps, setEmps] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [ov, ms] = await Promise.all([api.get('/engagement/overview').catch(() => ({ data: { data: null } })), api.get('/engagement/my/surveys')]);
      setOverview(ov.data.data); setMySurveys(ms.data.data);
      if (can('engagement.view')) {
        const [as, pl, sg] = await Promise.all([api.get('/engagement/surveys'), api.get('/engagement/polls'), api.get('/engagement/suggestions')]);
        setAllSurveys(as.data.data); setPolls(pl.data.data); setSuggestions(sg.data.data);
      } else {
        const [pl, sg] = await Promise.all([api.get('/engagement/polls'), api.get('/engagement/suggestions')]);
        setPolls(pl.data.data); setSuggestions(sg.data.data);
      }
      const rec = await api.get('/engagement/recognitions');
      setRecognitions(rec.data.data);
      if (can('engagement.respond')) api.get('/employees?limit=200').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const vote = async (poll, idx) => {
    try { await api.post(`/engagement/polls/${poll.id}/vote`, { optionIndex: idx }); toast('Vote recorded'); load(); } catch (e) { toast(errMsg(e), true); }
  };

  const submitSurvey = async (survey) => {
    try {
      const answers = Object.entries(form).map(([qid, value]) => ({ qid: Number(qid), value }));
      if (answers.length < survey.questions.length) { toast('Please answer all questions', true); return; }
      await api.post(`/engagement/surveys/${survey.id}/respond`, { answers });
      toast('Response submitted — thank you!');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const giveRecognition = async () => {
    try {
      await api.post('/engagement/recognitions', { toEmployeeId: Number(form.toEmployeeId), rtype: form.rtype || 'kudos', message: form.message });
      toast('Recognition sent 🎉');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const submitSuggestion = async () => {
    try {
      await api.post('/engagement/suggestions', { category: form.category || 'general', subject: form.subject, body: form.body, anonymous: !!form.anonymous });
      toast('Suggestion submitted');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const viewResults = async (survey) => {
    try { const { data } = await api.get(`/engagement/surveys/${survey.id}/results`); setModal({ type: 'results', data: data.data }); } catch (e) { toast(errMsg(e), true); }
  };

  const createSurvey = async () => {
    try {
      const questions = [{ id: 1, text: form.q1, type: 'rating' }, { id: 2, text: form.q2, type: 'rating' }, { id: 3, text: form.q3, type: 'text' }].filter((q) => q.text);
      if (!form.title || questions.length < 1) { toast('Title and at least one question required', true); return; }
      await api.post('/engagement/surveys', { title: form.title, description: form.description, stype: form.stype || 'pulse', anonymity: form.anonymity || 'anonymous', questions, status: 'active', startDate: form.startDate, endDate: form.endDate });
      toast('Survey launched');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createPoll = async () => {
    try {
      const options = [form.o1, form.o2, form.o3, form.o4].filter(Boolean);
      await api.post('/engagement/polls', { question: form.question, options, endsAt: form.endsAt || null });
      toast('Poll created');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!recognitions) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      {overview && (
        <div className="stat-grid">
          <StatCard label="Active surveys" value={overview.activeSurveys} />
          <StatCard label="Survey responses" value={overview.surveyResponses} />
          <StatCard label="Active polls" value={overview.activePolls} />
          <StatCard label="Recognitions (30d)" value={overview.recognitions30d} />
          <StatCard label="Open suggestions" value={overview.openSuggestions} />
        </div>
      )}

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'recognition', label: 'Recognition Wall' }, { key: 'surveys', label: 'Surveys' },
        { key: 'polls', label: 'Polls' }, { key: 'suggestions', label: 'Suggestions' },
      ]} /></div>

      {tab === 'recognition' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Recognition wall</h3>
            {can('engagement.respond') && <button className="btn sm" onClick={() => setModal({ type: 'recognize' })}>Give recognition</button>}
          </div>
          {recognitions.length === 0 && <Empty text="No recognitions yet — be the first to appreciate someone!" />}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 14 }}>
            {recognitions.map((r) => (
              <div key={r.id} className="card" style={{ margin: 0, borderLeft: `3px solid ${r.rtype === 'reward' ? 'var(--primary)' : r.rtype === 'badge' ? '#6941c6' : '#f79009'}` }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={'badge ' + (r.rtype === 'reward' ? 'purple' : r.rtype === 'badge' ? 'blue' : 'amber')}>{r.rtype.toUpperCase()}</span>
                  {r.points > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>+{r.points} pts</span>}
                </div>
                <div style={{ margin: '8px 0', fontSize: 14 }}>{r.message || '—'}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  <b>{r.from_name}</b> → <b>{r.to_name}</b> {r.to_department && `· ${r.to_department}`} · {fmtDate(r.created_at)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'surveys' && (
        <>
          {(mySurveys.length > 0) && (
            <div className="card mt">
              <div className="card-h"><h3>Surveys waiting for your response</h3></div>
              {mySurveys.filter((s) => !s.answered).map((s) => (
                <div key={s.id} className="spread" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div><b>{s.title}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{s.description} · {s.anonymity} · closes {fmtDate(s.end_date)}</div></div>
                  <button className="btn sm" onClick={() => { setForm({}); setModal({ type: 'respond', survey: s }); }}>Respond</button>
                </div>
              ))}
              {mySurveys.filter((s) => !s.answered).length === 0 && <div style={{ padding: 12, color: 'var(--muted)', fontSize: 13 }}>You're all caught up 🎉</div>}
            </div>
          )}
          {can('engagement.view') && (
            <div className="card mt">
              <div className="card-h spread">
                <h3>All surveys</h3>
                {can('engagement.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newSurvey' })}>New survey</button>}
              </div>
              <DataTable
                columns={[
                  { key: 'title', label: 'Survey', render: (r) => <><b>{r.title}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.stype} · {r.anonymity}</div></> },
                  { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
                  { key: 'end_date', label: 'Ends', render: (r) => r.end_date ? fmtDate(r.end_date) : '—' },
                ]}
                rows={allSurveys}
                emptyText="No surveys created"
                actions={(r) => <button className="btn ghost sm" onClick={() => viewResults(r)}>Results</button>}
              />
            </div>
          )}
        </>
      )}

      {tab === 'polls' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Polls</h3>
            {can('engagement.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newPoll' })}>New poll</button>}
          </div>
          {polls.length === 0 && <Empty text="No polls yet" />}
          {polls.map((p) => {
            const total = p.counts.reduce((a, c) => a + c.count, 0);
            return (
              <div key={p.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                <div className="spread"><b>{p.question}</b><StatusBadge value={p.status} /></div>
                <div style={{ margin: '10px 0' }}>
                  {(p.options || []).map((opt, i) => {
                    const count = p.counts.find((c) => c.optionIndex === i)?.count || 0;
                    return (
                      <div key={i} className={'bar-row'} style={{ cursor: p.status === 'active' && p.myVote === null && me?.employee_id ? 'pointer' : 'default' }}
                        onClick={() => p.status === 'active' && p.myVote === null && me?.employee_id && vote(p, i)}>
                        <div className="bar-lbl" style={{ width: '45%' }}>{opt} {p.myVote === i ? '✓' : ''}</div>
                        <div className="bar-track"><div className="bar-fill" style={{ width: `${total ? (count / total) * 100 : 0}%` }} /></div>
                        <div className="bar-val">{count}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'suggestions' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Suggestion box</h3>
            {can('engagement.respond') && <button className="btn sm" onClick={() => setModal({ type: 'newSuggestion' })}>Submit suggestion</button>}
          </div>
          <DataTable
            columns={[
              { key: 'subject', label: 'Suggestion', render: (r) => <><b>{r.subject}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.category}</div></> },
              { key: 'employee_name', label: 'From', render: (r) => r.employee_name },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'admin_notes', label: 'HR notes', render: (r) => r.admin_notes || '—' },
              { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at) },
            ]}
            rows={suggestions}
            emptyText="No suggestions yet"
            actions={(r) => can('engagement.manage') ? (
              <button className="btn ghost sm" onClick={() => {
                const status = prompt('Set status: submitted / reviewing / implemented / rejected', r.status);
                if (!status) return;
                const notes = prompt('HR note (optional)') || null;
                api.put(`/engagement/suggestions/${r.id}`, { status, adminNotes: notes }).then(() => { toast('Updated'); load(); }).catch((e) => toast(errMsg(e), true));
              }}>Update</button>
            ) : null}
          />
        </div>
      )}

      {modal?.type === 'respond' && (
        <Modal title={modal.survey.title} onClose={() => setModal(null)} footer={
          <><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={() => submitSurvey(modal.survey)}>Submit</button></>
        }>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{modal.survey.anonymity === 'anonymous' ? '🔒 Your response is anonymous.' : 'Your response is recorded with your name.'}</p>
          {(modal.survey.questions || []).map((q) => (
            <div className="field" key={q.id}>
              <label>{q.text}</label>
              {q.type === 'rating' ? (
                <div className="row" style={{ gap: 6 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button type="button" key={n} className={'btn sm' + (Number(form[q.id]) === n ? '' : ' secondary')}
                      onClick={() => setForm((f) => ({ ...f, [q.id]: n }))} style={{ minWidth: 40 }}>{n}</button>
                  ))}
                </div>
              ) : (
                <textarea rows={3} value={form[q.id] || ''} onChange={(e) => setForm((f) => ({ ...f, [q.id]: e.target.value }))} />
              )}
            </div>
          ))}
        </Modal>
      )}

      {modal?.type === 'results' && (
        <Modal title={`Results — ${modal.data.survey.title}`} onClose={() => setModal(null)} wide footer={<button className="btn secondary" onClick={() => setModal(null)}>Close</button>}>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{modal.data.responseCount} response(s) · {modal.data.survey.anonymity}</p>
          {modal.data.results.map((q, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <b>{q.text}</b> <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>({q.responses} responses)</span>
              {q.type === 'rating' && <><div style={{ fontSize: 13, margin: '4px 0' }}>Average: <b>{q.average}</b> / 5</div><BarList data={q.distribution.map((d) => ({ label: `${d.rating}★`, value: d.count }))} /></>}
              {q.type === 'choice' && <BarList data={Object.entries(q.counts || {}).map(([k, v]) => ({ label: k, value: v }))} />}
              {q.type === 'text' && (
                <ul style={{ fontSize: 13, paddingLeft: 18 }}>{(q.texts || []).map((t, j) => <li key={j}>{t}</li>)}</ul>
              )}
            </div>
          ))}
        </Modal>
      )}

      {modal?.type === 'recognize' && (
        <Modal title="Give recognition" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={giveRecognition}>Send</button></>}>
          <SelectField label="To *" value={form.toEmployeeId} onChange={setF('toEmployeeId')} options={emps.filter((e) => e.id !== me?.employee_id).map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name}` }))} />
          <SelectField label="Type" value={form.rtype} onChange={setF('rtype')} options={[
            { value: 'kudos', label: 'Kudos (+10 pts)' }, { value: 'badge', label: 'Badge (+25 pts)' }, { value: 'reward', label: 'Reward (+50 pts)' },
          ]} />
          <div className="field"><label>Message</label><textarea rows={3} value={form.message || ''} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} placeholder="Say what they did and why it mattered…" /></div>
        </Modal>
      )}

      {modal?.type === 'newSuggestion' && (
        <Modal title="Submit a suggestion" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={submitSuggestion}>Submit</button></>}>
          <SelectField label="Category" value={form.category} onChange={setF('category')} options={[
            { value: 'general', label: 'General' }, { value: 'facilities', label: 'Facilities' }, { value: 'policy', label: 'Policy' },
            { value: 'culture', label: 'Culture' }, { value: 'process', label: 'Process' },
          ]} />
          <TextField label="Subject *" value={form.subject} onChange={setF('subject')} />
          <div className="field"><label>Details</label><textarea rows={4} value={form.body || ''} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></div>
          <label className="check"><input type="checkbox" checked={!!form.anonymous} onChange={(e) => setForm((f) => ({ ...f, anonymous: e.target.checked }))} /> Submit anonymously</label>
        </Modal>
      )}

      {modal?.type === 'newSurvey' && (
        <Modal title="Launch survey" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createSurvey}>Launch</button></>}>
          <TextField label="Title *" value={form.title} onChange={setF('title')} />
          <TextField label="Description" value={form.description} onChange={setF('description')} />
          <div className="row">
            <SelectField label="Type" value={form.stype} onChange={setF('stype')} options={[{ value: 'pulse', label: 'Pulse' }, { value: 'annual', label: 'Annual' }]} />
            <SelectField label="Anonymity" value={form.anonymity} onChange={setF('anonymity')} options={[{ value: 'anonymous', label: 'Anonymous' }, { value: 'named', label: 'Named' }]} />
          </div>
          <TextField label="Question 1 (rating)" value={form.q1} onChange={setF('q1')} />
          <TextField label="Question 2 (rating)" value={form.q2} onChange={setF('q2')} />
          <TextField label="Question 3 (open text)" value={form.q3} onChange={setF('q3')} />
          <div className="row">
            <TextField label="Start date" type="date" value={form.startDate} onChange={setF('startDate')} />
            <TextField label="End date" type="date" value={form.endDate} onChange={setF('endDate')} />
          </div>
        </Modal>
      )}

      {modal?.type === 'newPoll' && (
        <Modal title="Create poll" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createPoll}>Create</button></>}>
          <TextField label="Question *" value={form.question} onChange={setF('question')} />
          <TextField label="Option 1 *" value={form.o1} onChange={setF('o1')} />
          <TextField label="Option 2 *" value={form.o2} onChange={setF('o2')} />
          <TextField label="Option 3" value={form.o3} onChange={setF('o3')} />
          <TextField label="Option 4" value={form.o4} onChange={setF('o4')} />
        </Modal>
      )}
    </>
  );
}
