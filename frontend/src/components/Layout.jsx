import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { api, fmtDate } from '../api';

const I = {
  dash: <path d="M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  emp: <path d="M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm11 9v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  clock: <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 7v5l3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></>,
  cal: <path d="M7 3v3M17 3v3M4 8h16M5 6h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  money: <path d="M12 2v20M17 6.5C17 4.6 14.8 4 12 4s-5 .8-5 2.5S9 9 12 9.5s5 1 5 3-2.2 2.5-5 2.5-5-.6-5-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  doc: <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5zm0 0v5h5M9 13h6M9 17h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  brief: <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 7h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  gear: <><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 2.8l1 2.6 2.7-.8 1.7 2.3 2.4 1.3-.4 2.8 1.6 2.3-1.6 2.3.4 2.8-2.4 1.3-1.7 2.3-2.7-.8-1 2.6-1-2.6-2.7.8-1.7-2.3-2.4-1.3.4-2.8L2.9 12l1.6-2.3-.4-2.8 2.4-1.3L8.2 3.3l2.7.8z" fill="none" stroke="currentColor" strokeWidth="1.3" /></>,
  bell: <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9zM10 20a2.2 2.2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  box: <path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  life: <path d="M12 21c-4-3-8-6.2-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 11c0 3.8-4 7-8 10z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  ticket: <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 6v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-6V7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  users: <path d="M16 11a4 4 0 1 0-4-4M22 21v-1a5 5 0 0 0-4-4.9M2 21v-1a6 6 0 0 1 9-5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
};
const Icon = ({ d }) => <svg viewBox="0 0 24 24" width="17" height="17">{d}</svg>;

export default function Layout() {
  const { me, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifs, setNotifs] = useState({ data: [], unread: 0 });
  const [showNotifs, setShowNotifs] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const notifRef = useRef(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (!me) return; // no session → no polling, no 401 spam
      try {
        const { data } = await api.get('/admin/my-notifications');
        if (!stop) setNotifs(data);
      } catch (_) {}
    };
    load();
    const t = setInterval(load, 30000);
    return () => { stop = true; clearInterval(t); };
  }, [loc.pathname, me]);

  useEffect(() => {
    const h = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) { setShowNotifs(false); setShowMenu(false); }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const markRead = async () => {
    await api.post('/admin/my-notifications/read', {});
    setNotifs((n) => ({ ...n, unread: 0, data: n.data.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })) }));
  };

  const navSections = [
    {
      label: 'Main', items: [
        { to: '/', icon: I.dash, label: 'Dashboard', show: true },
        { to: '/portal', icon: I.life, label: 'My Workspace', show: !!me?.employee_id },
      ],
    },
    {
      label: 'People', items: [
        { to: '/employees', icon: I.emp, label: 'Employees', show: can('employee.view') },
        { to: '/org/departments', icon: I.brief, label: 'Organization', show: can('org.view') },
        { to: '/attendance', icon: I.clock, label: 'Attendance', show: can('attendance.view') },
        { to: '/leave', icon: I.cal, label: 'Leave', show: can('leave.view') },
        { to: '/onboarding', icon: I.users, label: 'Onboarding & Exit', show: can('onboarding.view') || can('separation.view') },
      ],
    },
    {
      label: 'Pay & Finance', items: [
        { to: '/payroll', icon: I.money, label: 'Payroll', show: can('payroll.view') },
        { to: '/expenses', icon: I.doc, label: 'Expenses & Loans', show: can('expense.view') || can('loan.view') },
        { to: '/billing', icon: I.chart, label: 'Billing', show: can('billing.view') },
      ],
    },
    {
      label: 'Talent & Ops', items: [
        { to: '/recruitment', icon: I.users, label: 'Recruitment', show: can('recruitment.view') },
        { to: '/performance', icon: I.chart, label: 'Performance', show: can('performance.view') },
        { to: '/documents', icon: I.doc, label: 'Documents', show: can('document.view') },
        { to: '/assets', icon: I.box, label: 'Assets', show: can('asset.view') },
        { to: '/tickets', icon: I.ticket, label: 'Helpdesk', show: can('ticket.view') },
      ],
    },
    {
      label: 'Insights', items: [
        { to: '/reports', icon: I.chart, label: 'Reports', show: can('report.view') },
        { to: '/settings', icon: I.gear, label: 'Settings', show: can('settings.view') || can('user.manage') },
      ],
    },
  ];

  const title = navSections.flatMap((s) => s.items).find((i) => i.to !== '/' && loc.pathname.startsWith(i.to))?.label
    || (loc.pathname === '/' ? 'Dashboard' : 'HRMS');

  return (
    <div className="shell">
      <aside className={'sidebar' + (sidebarOpen ? ' open' : '')}>
        <div className="brand">
          <div className="logo">{me?.branding?.logoUrl ? <img src={me.branding.logoUrl} alt="" /> : (me?.branding?.companyName || 'A')[0]}</div>
          <b>{me?.branding?.companyName || 'Arthvex HRMS'}</b>
        </div>
        <nav style={{ flex: 1, paddingBottom: 20 }}>
          {navSections.map((sec) => {
            const items = sec.items.filter((i) => i.show);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={sec.label}>
                <div className="nav-label">{sec.label}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'}
                    className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                    onClick={() => setSidebarOpen(false)}>
                    <Icon d={i.icon} />{i.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn burger" onClick={() => setSidebarOpen((s) => !s)}>☰</button>
          <div className="page-title">{title}</div>
          <div ref={notifRef} style={{ position: 'relative' }}>
            <button className="icon-btn" onClick={() => { setShowNotifs((s) => !s); setShowMenu(false); }}>
              <svg viewBox="0 0 24 24" width="19" height="19">{I.bell}</svg>
              {notifs.unread > 0 && <span className="dot">{notifs.unread}</span>}
            </button>
            {showNotifs && (
              <div className="notif-pop">
                <div className="spread" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <b style={{ fontSize: 13.5 }}>Notifications</b>
                  <button className="btn ghost sm" onClick={markRead}>Mark all read</button>
                </div>
                {notifs.data.length === 0 && <div className="empty">No notifications</div>}
                {notifs.data.slice(0, 12).map((n) => (
                  <div key={n.id} className={'n' + (n.read_at ? '' : ' unread')} onClick={() => n.link && nav(n.link)}>
                    <b>{n.title}</b>
                    <p>{n.body}</p>
                    <time>{fmtDate(n.created_at, true)}</time>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div ref={notifRef} style={{ position: 'relative' }}>
            <button className="userchip" onClick={() => { setShowMenu((s) => !s); setShowNotifs(false); }}>
              <div className="avatar">{(me?.name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
              <div className="meta" style={{ textAlign: 'left' }}>
                <b>{me?.name}</b>
                <span>{me?.role?.replace(/_/g, ' ')}</span>
              </div>
            </button>
            {showMenu && (
              <div className="menu-pop">
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>{me?.email}</div>
                {me?.employee_id && <button className="mi" onClick={() => { nav('/portal/profile'); setShowMenu(false); }}>My profile</button>}
                {can('settings.view') && <button className="mi" onClick={() => { nav('/settings'); setShowMenu(false); }}>Settings</button>}
                <button className="mi" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
              </div>
            )}
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
