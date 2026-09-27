import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast, Empty, StatusBadge } from '../components/ui';

export default function Onboarding() {
  const { can } = useAuth();
  const toast = useToast();
  const [groups, setGroups] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/lifecycle/onboarding');
      setGroups(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (t) => {
    try {
      await api.post(`/lifecycle/onboarding/${t.id}/complete`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!groups) return <Spinner />;

  return (
    <div className="grid c2">
      {groups.length === 0 && <div className="card"><div className="card-b"><Empty icon="🎉" text="No onboarding in progress" /></div></div>}
      {groups.map((g) => {
        const done = g.tasks.filter((t) => t.status === 'completed').length;
        return (
          <div className="card" key={g.employeeId}>
            <div className="card-h">
              <h3>{g.name} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12.5 }}>· {g.employeeCode} · joins {fmtDate(g.joinedOn)}</span></h3>
              <span className="badge blue">{done}/{g.tasks.length} done</span>
            </div>
            <div className="card-b">
              {g.tasks.map((t) => (
                <div className="spread" key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <label className="check" style={{ margin: 0 }}>
                    <input type="checkbox" checked={t.status === 'completed'} onChange={() => toggle(t)} disabled={t.status !== 'pending' && t.status !== 'completed' ? true : false} />
                    <span style={{ fontSize: 13.5 }}>{t.title}</span>
                  </label>
                  <span className="badge gray">{t.category} · {t.assignee_role}</span>
                </div>
              ))}
              {done === g.tasks.length && <p style={{ color: 'var(--green)', fontSize: 13, marginTop: 10 }}>✅ All tasks complete — employee auto-activated.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
