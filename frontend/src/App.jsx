import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';

import Login from './pages/Login';
import AdminLogin from './pages/AdminLogin';
import ErrorBoundary from './components/ErrorBoundary';
import Dashboard from './pages/Dashboard';
import Employees from './pages/Employees';
import EmployeeDetail from './pages/EmployeeDetail';
import OrgPage from './pages/OrgPage';
import AttendanceRegister from './pages/AttendanceRegister';
import MonthlyRegister from './pages/MonthlyRegister';
import Regularizations from './pages/Regularizations';
import LeaveAdmin from './pages/LeaveAdmin';
import Holidays from './pages/Holidays';
import PayrollRuns from './pages/PayrollRuns';
import PayrollRunDetail from './pages/PayrollRunDetail';
import PayrollAdjustments from './pages/PayrollAdjustments';
import StatutoryReturns from './pages/StatutoryReturns';
import SalaryStructures from './pages/SalaryStructures';
import Statutory from './pages/Statutory';
import Expenses from './pages/Expenses';
import Loans from './pages/Loans';
import DocumentsAdmin from './pages/DocumentsAdmin';
import Performance from './pages/Performance';
import Recruitment from './pages/Recruitment';
import Assets from './pages/Assets';
import Tickets from './pages/Tickets';
import Onboarding from './pages/Onboarding';
import Separations from './pages/Separations';
import Billing from './pages/Billing';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
// v2 modules
import Talent from './pages/Talent';
import Engagement from './pages/Engagement';
import Relations from './pages/Relations';
import Travel from './pages/Travel';
import Compensation from './pages/Compensation';
import Benefits from './pages/Benefits';
import WorkforcePlanning from './pages/WorkforcePlanning';
import Analytics from './pages/Analytics';
import Workflows from './pages/Workflows';
import Timesheets from './pages/Timesheets';
import Integrations from './pages/Integrations';
import NotificationCenter from './pages/NotificationCenter';
import Security from './pages/Security';
import AiAssistant from './pages/AiAssistant';

// Administration Center
import { AdminShell } from './pages/administration/shared';
import AdminDashboard from './pages/administration/Dashboard';
import AdminOrganization from './pages/administration/Organization';
import AdminTeams from './pages/administration/Teams';
import AdminPositions from './pages/administration/Positions';
import AdminUsers from './pages/administration/Users';
import AdminRoles from './pages/administration/Roles';
import AdminPermissions from './pages/administration/Permissions';
import AdminAccess from './pages/administration/AccessReview';
import AdminCompanies from './pages/administration/Companies';
import AdminModules from './pages/administration/Modules';
import AdminSecurity from './pages/administration/Security';
import AdminConfig from './pages/administration/ConfigHistory';
import AdminOnboarding from './pages/administration/Onboarding';
import AdminAudit from './pages/administration/Audit';
import AdminDataOps from './pages/administration/DataOps';
import AdminWorkflows from './pages/administration/Workflows';
import AdminCustomization from './pages/administration/Customization';
import AdminMasterData from './pages/administration/MasterData';

// Platform Control Plane
import { PlatformShell } from './pages/platform/shared';
import PlatformDashboard from './pages/platform/Dashboard';
import PlatformCompanies from './pages/platform/Companies';
import PlatformCompanyDetail from './pages/platform/CompanyDetail';
import PlatformSubscriptions from './pages/platform/Subscriptions';
import PlatformPlans from './pages/platform/Plans';
import PlatformEntitlements from './pages/platform/Entitlements';
import PlatformSupportAccess from './pages/platform/SupportAccess';
import PlatformAudit from './pages/platform/Audit';
import PlatformOperators from './pages/platform/Operators';
import PlatformSecurity from './pages/platform/Security';
import PlatformInvoices from './pages/platform/Invoices';
import PlatformRoles from './pages/platform/Roles';
import PlatformSupportTickets from './pages/platform/Support';
import PlatformOperations from './pages/platform/Operations';
import Account from './pages/Account';

import PortalHome from './pages/portal/PortalHome';
import MyAttendance from './pages/portal/MyAttendance';
import MyLeave from './pages/portal/MyLeave';
import MyPayslips from './pages/portal/MyPayslips';
import MyDocuments from './pages/portal/MyDocuments';
import MyExpenses from './pages/portal/MyExpenses';
import MyTravel from './pages/portal/MyTravel';
import MyProfile from './pages/portal/MyProfile';

const MODULE_LABELS = {
  employees: 'Employees', attendance: 'Attendance', leave: 'Leave', timesheets: 'Timesheets',
  payroll: 'Payroll', compensation: 'Compensation', benefits: 'Benefits', travel: 'Travel',
  workforce_planning: 'Workforce Planning', analytics: 'People Analytics', ai_assistant: 'AI HR Assistant',
  integrations: 'Integrations', notifications: 'Notifications', documents: 'Documents',
};

function Guard({ children, perm, anyOf, module }) {
  const { me, loading, can, moduleOn } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  // A platform account has no company, so every tenant screen would be an empty shell that
  // fails API calls. Its home is the control plane; the Administration Center stays reachable.
  if (me.isPlatformAdmin && !loc.pathname.startsWith('/administration') && loc.pathname !== '/') {
    return <Navigate to="/platform" replace />;
  }
  const denied = (perm && !can(perm)) || (anyOf && !anyOf.some((p) => can(p)));
  if (denied) return (
    <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <h3>Access denied</h3>
      <p>Your role does not include the permission required for this page.</p>
    </div>
  );
  // Checked before the page mounts, so a disabled module never issues the requests
  // its endpoints would refuse anyway.
  if (module && !moduleOn(module)) return (
    <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <h3>Module disabled</h3>
      <p>
        The {MODULE_LABELS[module] || module} module is switched off for {me.tenantName || 'your company'}.
        {' '}An administrator can turn it back on under Administration → Modules &amp; Features.
      </p>
    </div>
  );
  return children;
}

/** Only a platform account may enter the control plane, and only after login. */
function PlatformGuard({ children }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!me.isPlatformAdmin) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center', margin: 40 }}>
        <h3>Platform console</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>
          This account belongs to a company, not to ARTHVEX. The control plane is reserved for
          platform staff.
        </p>
      </div>
    );
  }
  return children;
}

/**
 * Where a signed-in account belongs. A platform operator has no company, so the
 * HRMS dashboard would be an empty, misleading screen — the control plane is
 * their home. This is a convenience redirect only: every route below is still
 * gated on the server's own answer to "may this account do this".
 */
function Landing() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.isPlatformAdmin) return <Navigate to="/platform" replace />;
  return <Dashboard />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Second door into the same session: administrators sign in at /admin. Reach is
          still decided by the server from the account's role, not by this route. */}
      <Route path="/admin" element={<AdminLogin />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Guard><ErrorBoundary><Landing /></ErrorBoundary></Guard>} />
        <Route path="/employees" element={<Guard perm="employee.view" module="employees"><ErrorBoundary><Employees /></ErrorBoundary></Guard>} />
        <Route path="/employees/:id" element={<Guard perm="employee.view" module="employees"><ErrorBoundary><EmployeeDetail /></ErrorBoundary></Guard>} />
        <Route path="/org/:resource" element={<Guard perm="org.view"><OrgPage /></Guard>} />
        <Route path="/attendance" element={<Guard perm="attendance.view" module="attendance"><AttendanceRegister /></Guard>} />
        <Route path="/attendance/monthly" element={<Guard perm="attendance.view" module="attendance"><MonthlyRegister /></Guard>} />
        <Route path="/attendance/regularizations" element={<Guard module="attendance"><Regularizations /></Guard>} />
        <Route path="/leave" element={<Guard perm="leave.view" module="leave"><LeaveAdmin /></Guard>} />
        <Route path="/leave/holidays" element={<Guard module="leave"><Holidays /></Guard>} />
        <Route path="/payroll" element={<Guard perm="payroll.view" module="payroll"><PayrollRuns /></Guard>} />
        <Route path="/payroll/:id" element={<Guard perm="payroll.view" module="payroll"><PayrollRunDetail /></Guard>} />
        <Route path="/payroll/structures" element={<Guard perm="payroll.view" module="payroll"><SalaryStructures /></Guard>} />
        <Route path="/payroll/adjustments" element={<Guard perm="payroll.view" module="payroll"><PayrollAdjustments /></Guard>} />
        <Route path="/payroll/statutory" element={<Guard perm="payroll.view" module="payroll"><Statutory /></Guard>} />
        <Route path="/payroll/statutory/returns" element={<Guard perm="payroll.view" module="payroll"><StatutoryReturns /></Guard>} />
        <Route path="/expenses" element={<Guard module="expenses"><Expenses /></Guard>} />
        <Route path="/loans" element={<Guard module="loans"><Loans /></Guard>} />
        <Route path="/documents" element={<Guard module="documents"><DocumentsAdmin /></Guard>} />
        <Route path="/performance" element={<Guard module="performance"><Performance /></Guard>} />
        <Route path="/recruitment" element={<Guard perm="recruitment.view" module="recruitment"><Recruitment /></Guard>} />
        <Route path="/assets" element={<Guard perm="asset.view" module="assets"><Assets /></Guard>} />
        <Route path="/tickets" element={<Guard perm="ticket.view" module="helpdesk"><Tickets /></Guard>} />
        <Route path="/onboarding" element={<Guard anyOf={['onboarding.view', 'separation.view']} module="lifecycle"><Onboarding /></Guard>} />
        <Route path="/separations" element={<Guard anyOf={['onboarding.view', 'separation.view']} module="lifecycle"><Separations /></Guard>} />
        <Route path="/billing" element={<Guard perm="billing.view" module="billing"><Billing /></Guard>} />
        <Route path="/reports" element={<Guard perm="report.view"><Reports /></Guard>} />
        <Route path="/settings" element={<Guard><Settings /></Guard>} />
        <Route path="/account" element={<Guard perm="settings.manage"><ErrorBoundary><Account /></ErrorBoundary></Guard>} />

        {/* v2 modules */}
        <Route path="/talent" element={<Guard perm="talent.view" module="talent"><ErrorBoundary><Talent /></ErrorBoundary></Guard>} />
        <Route path="/engagement" element={<Guard module="engagement"><ErrorBoundary><Engagement /></ErrorBoundary></Guard>} />
        <Route path="/relations" element={<Guard perm="relations.view" module="employee_relations"><ErrorBoundary><Relations /></ErrorBoundary></Guard>} />
        <Route path="/travel" element={<Guard module="travel"><ErrorBoundary><Travel /></ErrorBoundary></Guard>} />
        <Route path="/compensation" element={<Guard perm="compensation.view" module="compensation"><ErrorBoundary><Compensation /></ErrorBoundary></Guard>} />
        <Route path="/benefits" element={<Guard module="benefits"><ErrorBoundary><Benefits /></ErrorBoundary></Guard>} />
        <Route path="/workforce" element={<Guard perm="workforce.view" module="workforce_planning"><ErrorBoundary><WorkforcePlanning /></ErrorBoundary></Guard>} />
        <Route path="/analytics" element={<Guard perm="analytics.view" module="analytics"><ErrorBoundary><Analytics /></ErrorBoundary></Guard>} />
        <Route path="/workflows" element={<Guard module="workflow"><ErrorBoundary><Workflows /></ErrorBoundary></Guard>} />
        <Route path="/timesheets" element={<Guard module="timesheets"><ErrorBoundary><Timesheets /></ErrorBoundary></Guard>} />
        <Route path="/integrations" element={<Guard perm="integration.manage" module="integrations"><ErrorBoundary><Integrations /></ErrorBoundary></Guard>} />
        <Route path="/notifications" element={<Guard module="notifications"><ErrorBoundary><NotificationCenter /></ErrorBoundary></Guard>} />
        <Route path="/security" element={<Guard><ErrorBoundary><Security /></ErrorBoundary></Guard>} />
        <Route path="/ai-assistant" element={<Guard module="ai_assistant"><ErrorBoundary><AiAssistant /></ErrorBoundary></Guard>} />

        {/* Administration Center — AdminShell reads /administration/meta and
            AdminSection enforces per-section access, so no blanket perm here. */}
        <Route path="/administration" element={<Guard><ErrorBoundary><AdminShell /></ErrorBoundary></Guard>}>
          <Route index element={<ErrorBoundary><AdminDashboard /></ErrorBoundary>} />
          <Route path="organization" element={<ErrorBoundary><AdminOrganization /></ErrorBoundary>} />
          <Route path="teams" element={<ErrorBoundary><AdminTeams /></ErrorBoundary>} />
          <Route path="positions" element={<ErrorBoundary><AdminPositions /></ErrorBoundary>} />
          <Route path="users" element={<ErrorBoundary><AdminUsers /></ErrorBoundary>} />
          <Route path="roles" element={<ErrorBoundary><AdminRoles /></ErrorBoundary>} />
          <Route path="permissions" element={<ErrorBoundary><AdminPermissions /></ErrorBoundary>} />
          <Route path="access" element={<ErrorBoundary><AdminAccess /></ErrorBoundary>} />
          <Route path="workflows" element={<ErrorBoundary><AdminWorkflows /></ErrorBoundary>} />
          <Route path="customization" element={<ErrorBoundary><AdminCustomization /></ErrorBoundary>} />
          <Route path="master-data" element={<ErrorBoundary><AdminMasterData /></ErrorBoundary>} />
          <Route path="modules" element={<ErrorBoundary><AdminModules /></ErrorBoundary>} />
          <Route path="security" element={<ErrorBoundary><AdminSecurity /></ErrorBoundary>} />
          <Route path="config" element={<ErrorBoundary><AdminConfig /></ErrorBoundary>} />
          <Route path="data" element={<ErrorBoundary><AdminDataOps /></ErrorBoundary>} />
          <Route path="onboarding" element={<ErrorBoundary><AdminOnboarding /></ErrorBoundary>} />
          <Route path="audit" element={<ErrorBoundary><AdminAudit /></ErrorBoundary>} />
          <Route path="tenants" element={<ErrorBoundary><AdminCompanies /></ErrorBoundary>} />
        </Route>

        {/* Employee portal */}
        <Route path="/portal" element={<Guard><PortalHome /></Guard>} />
        <Route path="/portal/attendance" element={<Guard><MyAttendance /></Guard>} />
        <Route path="/portal/leave" element={<Guard><MyLeave /></Guard>} />
        <Route path="/portal/payslips" element={<Guard><MyPayslips /></Guard>} />
        <Route path="/portal/documents" element={<Guard><MyDocuments /></Guard>} />
        <Route path="/portal/expenses" element={<Guard><MyExpenses /></Guard>} />
        <Route path="/portal/travel" element={<Guard module="travel"><MyTravel /></Guard>} />
        <Route path="/portal/profile" element={<Guard><MyProfile /></Guard>} />
      </Route>

      {/* Platform Control Plane. Deliberately outside the tenant Layout: a
          platform operator has no company, no employee record and no employee
          navigation, so drawing the HRMS chrome would imply access they lack. */}
      <Route element={<PlatformGuard><PlatformShell /></PlatformGuard>}>
        <Route path="/platform" element={<ErrorBoundary><PlatformDashboard /></ErrorBoundary>} />
        <Route path="/platform/companies" element={<ErrorBoundary><PlatformCompanies /></ErrorBoundary>} />
        <Route path="/platform/companies/:id" element={<ErrorBoundary><PlatformCompanyDetail /></ErrorBoundary>} />
        <Route path="/platform/subscriptions" element={<ErrorBoundary><PlatformSubscriptions /></ErrorBoundary>} />
        <Route path="/platform/plans" element={<ErrorBoundary><PlatformPlans /></ErrorBoundary>} />
        <Route path="/platform/entitlements" element={<ErrorBoundary><PlatformEntitlements /></ErrorBoundary>} />
        <Route path="/platform/support-access" element={<ErrorBoundary><PlatformSupportAccess /></ErrorBoundary>} />
        <Route path="/platform/audit" element={<ErrorBoundary><PlatformAudit /></ErrorBoundary>} />
        <Route path="/platform/operators" element={<ErrorBoundary><PlatformOperators /></ErrorBoundary>} />
        <Route path="/platform/support-tickets" element={<ErrorBoundary><PlatformSupportTickets /></ErrorBoundary>} />
        <Route path="/platform/operations" element={<ErrorBoundary><PlatformOperations /></ErrorBoundary>} />
        <Route path="/platform/roles" element={<ErrorBoundary><PlatformRoles /></ErrorBoundary>} />
        <Route path="/platform/security" element={<ErrorBoundary><PlatformSecurity /></ErrorBoundary>} />
        <Route path="/platform/invoices" element={<ErrorBoundary><PlatformInvoices /></ErrorBoundary>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
