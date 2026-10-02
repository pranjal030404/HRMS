import React, { useState } from 'react';
import { api, fmtDate } from '../../api';
import DataTable from '../../components/DataTable';
import { Empty, Spinner, StatusBadge, Tabs, useToast } from '../../components/ui';
import { AdminSection, PageHeader, num, useLoader, listLoader } from './shared';

const EMPTY_STRUCTURE = {
  businessUnits: [], unassignedDepartments: [], standaloneTeams: [], positionsWithoutDepartment: [],
  jobLevels: [], grades: [], counts: {},
};

export default function AdminOrganization() {
  return (
    <AdminSection sectionKey="organization">
      <Organization />
    </AdminSection>
  );
}

function Organization() {
  const [tab, setTab] = useState('structure');
  const { data, loading, reload } = useLoader(listLoader('/administration/organization/structure'), []);

  const counts = data?.counts || {};
  return (
    <div>
      <PageHeader
        title="Organization Builder"
        sub="Business units, departments, teams and positions — the shape every other module reads from."
        actions={<button className="btn secondary sm" onClick={() => reload()}>Refresh</button>}
      />

      <div className="stat-grid mb">
        <Stat label="Business units" value={counts.businessUnits} />
        <Stat label="Departments" value={counts.departments} />
        <Stat label="Teams" value={counts.teams} />
        <Stat label="Positions" value={counts.positions} sub={`${num(counts.vacancies)} vacant`} />
        <Stat label="Headcount" value={counts.headcount} />
      </div>

      <Tabs
        tabs={[
          { key: 'structure', label: 'Structure' },
          { key: 'teams', label: 'Teams' },
          { key: 'positions', label: 'Positions' },
          { key: 'levels', label: 'Levels & Grades' },
          { key: 'health', label: 'Health' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          {tab === 'structure' && <StructureView data={data} />}
          {tab === 'teams' && <TeamsView data={data} />}
          {tab === 'positions' && <PositionsView data={data} />}
          {tab === 'levels' && <LevelsView data={data} />}
          {tab === 'health' && <HealthView />}
        </>
      )}
    </div>
  );
}

const Stat = ({ label, value, sub }) => (
  <div className="card stat">
    <div className="lbl">{label}</div>
    <div className="val">{num(value)}</div>
    {sub && <div className="sub">{sub}</div>}
  </div>
);

/** Business unit → department → sub-department → team/position. */
function StructureView({ data }) {
  if (!data.businessUnits.length && !data.unassignedDepartments.length) {
    return <Empty icon="🏢" text="No business units or departments yet" />;
  }
  return (
    <div className="card">
      <div className="card-h"><h3>Structure</h3></div>
      <div className="card-b">
        <div className="org-tree">
          <ul style={{ paddingLeft: 0, borderLeft: 'none' }}>
            {data.businessUnits.map((bu) => (
              <li key={`bu-${bu.id}`}>
                <div className="org-node">
                  <strong>{bu.name}</strong>
                  <span className="badge blue">{bu.code}</span>
                  {bu.head_name && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Head: {bu.head_name}</span>}
                </div>
                <ul>
                  {bu.departments.map((d) => (
                    <li key={`d-${d.id}`}>
                      <div className="org-node">
                        <strong>{d.name}</strong>
                        <span className="badge gray">{num(d.headcount)} people</span>
                        {!d.head_name && <span className="badge amber">no head</span>}
                      </div>
                      <ul>
                        {(d.subDepartments || []).map((s) => (
                          <li key={`sd-${s.id}`}>
                            <div className="org-node">
                              {s.name}
                              <span className="badge gray">{num(s.headcount)}</span>
                            </div>
                          </li>
                        ))}
                        {(d.teams || []).map((t) => (
                          <li key={`t-${t.id}`}>
                            <div className="org-node">
                              <span style={{ color: 'var(--primary)' }}>▸</span> {t.name}
                              <span className="badge gray">{num(t.member_count)} members</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {data.unassignedDepartments.length > 0 && (
              <li>
                <div className="org-node" style={{ borderColor: 'var(--amber)' }}>
                  <span className="badge amber">unassigned</span>
                  {data.unassignedDepartments.map((d) => d.name).join(', ')}
                </div>
              </li>
            )}
            {data.standaloneTeams.length > 0 && (
              <li>
                <div className="org-node" style={{ borderColor: 'var(--amber)' }}>
                  <span className="badge amber">no department</span>
                  {data.standaloneTeams.map((t) => t.name).join(', ')}
                </div>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

function TeamsView({ data }) {
  const teams = [
    ...data.businessUnits.flatMap((bu) => bu.departments.flatMap((d) => (d.teams || []).map((t) => ({ ...t, unit: bu.name, dept: d.name })))),
    ...data.standaloneTeams.map((t) => ({ ...t, unit: null, dept: null })),
  ];
  return (
    <DataTable
      rows={teams}
      columns={[
        { key: 'name', label: 'Team' },
        { key: 'unit', label: 'Business unit', render: (r) => r.unit || <span className="badge amber">—</span> },
        { key: 'dept', label: 'Department', render: (r) => r.dept || <span className="badge amber">—</span> },
        { key: 'lead_name', label: 'Lead', render: (r) => r.lead_name || <span className="badge amber">unassigned</span> },
        { key: 'member_count', label: 'Members', align: 'right', sortValue: (r) => Number(r.member_count || 0) },
        { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
      ]}
      emptyText="No teams defined"
    />
  );
}

function PositionsView({ data }) {
  const positions = [
    ...data.businessUnits.flatMap((bu) => bu.departments.flatMap((d) => (d.positions || []).map((p) => ({ ...p, dept: d.name })))),
    ...data.positionsWithoutDepartment.map((p) => ({ ...p, dept: null })),
  ];
  return (
    <DataTable
      rows={positions}
      columns={[
        { key: 'title', label: 'Title' },
        { key: 'code', label: 'Code' },
        { key: 'dept', label: 'Department', render: (r) => r.dept || <span className="badge amber">unassigned</span> },
        { key: 'designation_name', label: 'Designation' },
        { key: 'grade_name', label: 'Grade' },
        { key: 'job_level_name', label: 'Level' },
        {
          key: 'openings', label: 'Filled / Open', align: 'right',
          render: (r) => {
            const open = Math.max(0, Number(r.openings || 0) - Number(r.filled || 0));
            return <>{num(r.filled)} / {num(r.openings)}{open > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>{open} open</span>}</>;
          },
        },
      ]}
      emptyText="No positions defined"
    />
  );
}

function LevelsView({ data }) {
  return (
    <div className="grid c2">
      <DataTable
        rows={data.jobLevels}
        columns={[
          { key: 'name', label: 'Job level' },
          { key: 'code', label: 'Code' },
          { key: 'level', label: 'Order', align: 'right', sortValue: (r) => Number(r.level || 0) },
        ]}
        emptyText="No job levels"
      />
      <DataTable
        rows={data.grades}
        columns={[
          { key: 'name', label: 'Grade' },
          { key: 'code', label: 'Code' },
          { key: 'level', label: 'Level', align: 'right', sortValue: (r) => Number(r.level || 0) },
          { key: 'career_track', label: 'Track' },
        ]}
        emptyText="No grades"
      />
    </div>
  );
}

/** Configuration gaps that quietly break downstream modules. */
function HealthView() {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/organization/health'), []);

  if (loading && !data) return <Spinner />;
  const issues = data || [];
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return (
    <div>
      <div className="row mb" style={{ gap: 10 }}>
        <span className="badge red">{critical} critical</span>
        <span className="badge amber">{warnings} warning</span>
        <button className="btn secondary sm" onClick={() => reload()}>Re-check</button>
      </div>
      {issues.length === 0 ? (
        <div className="card"><div className="card-b"><Empty icon="✅" text="No configuration gaps found" /></div></div>
      ) : (
        <div className="grid c2">
          {issues.map((i) => (
            <div className="card" key={i.key}>
              <div className="card-h">
                <h3>{i.message}</h3>
                <StatusBadge value={i.severity} labels={{ critical: ['red', 'Critical'], warning: ['amber', 'Warning'], info: ['blue', 'Info'] }} />
              </div>
              <div className="card-b">
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)' }}>
                  {(i.items || []).map((it, idx) => <li key={idx}>{it.name || it.id}</li>)}
                  {!(i.items || []).length && <li>No individual items listed</li>}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}