import React from 'react';
import { api, errMsg } from '../../api';
import { useAuth } from '../../auth';
import { Empty, Spinner, useToast } from '../../components/ui';
import { AdminSection, PageHeader, getLoader, num, useLoader } from './shared';

export default function AdminOnboarding() {
  return (
    <AdminSection sectionKey="onboarding">
      <Onboarding />
    </AdminSection>
  );
}

/**
 * Setup progress. Every step is a live query against real data on the server —
 * marking one done here cannot make a half-configured company look complete.
 */
function Onboarding() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(getLoader('/administration/onboarding'), []);
  const canManage = can('administration.onboarding.manage');

  const mark = async (step, skipped) => {
    try {
      await api.put(`/administration/onboarding/step/${step.key}`, { skipped });
      toast(skipped ? `${step.title} skipped` : `${step.title} marked complete`);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (loading && !data) return <Spinner />;
  if (!data) return <Empty />;
  const { checklist = [], progress = {} } = data;

  return (
    <div>
      <PageHeader title="Onboarding" sub="Where this company stands on the road to being fully configured." />

      <div className="card mb">
        <div className="card-h"><h3>Setup progress</h3><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{progress.complete}/{progress.total} steps</span></div>
        <div className="card-b">
          <div className="bar-track" style={{ height: 12 }}>
            <div className="bar-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <p style={{ fontSize: 13, marginTop: 10, color: 'var(--muted)' }}>
            {progress.percent}% complete. Steps below are measured against live data, not a manual checklist.
          </p>
        </div>
      </div>

      <div className="grid c2">
        {checklist.map((s) => (
          <div className="card" key={s.key}>
            <div className="card-h">
              <h3>
                <span className="badge gray" style={{ marginRight: 8 }}>{s.step}</span>
                {s.title}
              </h3>
              {s.skipped
                ? <span className="badge gray">skipped</span>
                : s.done
                  ? <span className="badge green">done</span>
                  : <span className="badge amber">outstanding</span>}
            </div>
            <div className="card-b">
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>{s.description}</p>
              {canManage && !s.done && (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm" onClick={() => mark(s, false)}>Mark done</button>
                  <button className="btn ghost sm" onClick={() => mark(s, true)}>Skip</button>
                </div>
              )}
              {canManage && s.skipped && (
                <button className="btn ghost sm" onClick={() => mark(s, false)}>Un-skip</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}