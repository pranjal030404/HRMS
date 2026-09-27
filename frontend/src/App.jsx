import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';

import Login from './pages/Login';
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

import PortalHome from './pages/portal/PortalHome';
import MyAttendance from './pages/portal/MyAttendance';
import MyLeave from './pages/portal/MyLeave';
import MyPayslips from './pages/portal/MyPayslips';
import MyDocuments from './pages/portal/MyDocuments';
import MyExpenses from './pages/portal/MyExpenses';
import MyProfile from './pages/portal/MyProfile';

function Guard({ children, perm }) {
  const { me, loading, can } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (perm && !can(perm)) return (
    <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <h3>Access denied</h3>
      <p>Your role does not include the permission required for this page.</p>
    </div>
  );
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Guard><ErrorBoundary><Dashboard /></ErrorBoundary></Guard>} />
        <Route path="/employees" element={<Guard perm="employee.view"><ErrorBoundary><Employees /></ErrorBoundary></Guard>} />
        <Route path="/employees/:id" element={<Guard perm="employee.view"><ErrorBoundary><EmployeeDetail /></ErrorBoundary></Guard>} />
        <Route path="/org/:resource" element={<Guard perm="org.view"><OrgPage /></Guard>} />
        <Route path="/attendance" element={<Guard perm="attendance.view"><AttendanceRegister /></Guard>} />
        <Route path="/attendance/monthly" element={<Guard perm="attendance.view"><MonthlyRegister /></Guard>} />
        <Route path="/attendance/regularizations" element={<Guard><Regularizations /></Guard>} />
        <Route path="/leave" element={<Guard><LeaveAdmin /></Guard>} />
        <Route path="/leave/holidays" element={<Guard><Holidays /></Guard>} />
        <Route path="/payroll" element={<Guard perm="payroll.view"><PayrollRuns /></Guard>} />
        <Route path="/payroll/:id" element={<Guard perm="payroll.view"><PayrollRunDetail /></Guard>} />
        <Route path="/payroll/structures" element={<Guard perm="payroll.view"><SalaryStructures /></Guard>} />
        <Route path="/payroll/statutory" element={<Guard><Statutory /></Guard>} />
        <Route path="/expenses" element={<Guard><Expenses /></Guard>} />
        <Route path="/loans" element={<Guard><Loans /></Guard>} />
        <Route path="/documents" element={<Guard><DocumentsAdmin /></Guard>} />
        <Route path="/performance" element={<Guard><Performance /></Guard>} />
        <Route path="/recruitment" element={<Guard><Recruitment /></Guard>} />
        <Route path="/assets" element={<Guard><Assets /></Guard>} />
        <Route path="/tickets" element={<Guard><Tickets /></Guard>} />
        <Route path="/onboarding" element={<Guard><Onboarding /></Guard>} />
        <Route path="/separations" element={<Guard><Separations /></Guard>} />
        <Route path="/billing" element={<Guard><Billing /></Guard>} />
        <Route path="/reports" element={<Guard><Reports /></Guard>} />
        <Route path="/settings" element={<Guard><Settings /></Guard>} />

        {/* Employee portal */}
        <Route path="/portal" element={<Guard><PortalHome /></Guard>} />
        <Route path="/portal/attendance" element={<Guard><MyAttendance /></Guard>} />
        <Route path="/portal/leave" element={<Guard><MyLeave /></Guard>} />
        <Route path="/portal/payslips" element={<Guard><MyPayslips /></Guard>} />
        <Route path="/portal/documents" element={<Guard><MyDocuments /></Guard>} />
        <Route path="/portal/expenses" element={<Guard><MyExpenses /></Guard>} />
        <Route path="/portal/profile" element={<Guard><MyProfile /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
