import React, { useEffect, useState } from 'react';
import { useParams, Link, NavLink } from 'react-router-dom';
import CrudPage from '../components/CrudPage';
import { api } from '../api';

const RESOURCES = {
  departments: {
    title: 'Departments', singular: 'department',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'code', label: 'Code' },
      { key: 'status', label: 'Status' },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  designations: {
    title: 'Designations', singular: 'designation',
    columns: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'grade_id', label: 'Grade', render: (r) => r.gradeName || '—' }, { key: 'status', label: 'Status' }],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' },
      { key: 'grade_id', label: 'Grade', type: 'select', options: 'grades' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  grades: {
    title: 'Grades & levels', singular: 'grade',
    columns: [{ key: 'name', label: 'Name' }, { key: 'level', label: 'Level', align: 'right' }, { key: 'status', label: 'Status' }],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'level', label: 'Level', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  locations: {
    title: 'Locations', singular: 'location',
    columns: [{ key: 'name', label: 'Name' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'status', label: 'Status' }],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' },
      { key: 'address', label: 'Address' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  'cost-centers': {
    title: 'Cost centers', singular: 'cost center',
    columns: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'status', label: 'Status' }],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  shifts: {
    title: 'Shifts', singular: 'shift',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'start_time', label: 'Start' }, { key: 'end_time', label: 'End' },
      { key: 'grace_minutes', label: 'Grace (min)', align: 'right' },
      { key: 'weekly_offs', label: 'Weekly off', render: (r) => { try { return JSON.parse(r.weekly_offs || '[]').join(', ') || '—'; } catch { return '—'; } } },
      { key: 'status', label: 'Status' },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code' },
      { key: 'start_time', label: 'Start time', type: 'time' }, { key: 'end_time', label: 'End time', type: 'time' },
      { key: 'grace_minutes', label: 'Grace minutes', type: 'number' },
      { key: 'full_day_hours', label: 'Full day hours', type: 'number' },
      { key: 'half_day_hours', label: 'Half day hours', type: 'number' },
      { key: 'break_minutes', label: 'Break minutes', type: 'number' },
      { key: 'weekly_offs', label: 'Weekly offs (comma sep)', hint: 'e.g. Sun or Sat, Sun' },
      { key: 'overtime_enabled', label: 'Overtime enabled', type: 'check' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
  'leave-types': {
    title: 'Leave types & policies', singular: 'leave type',
    columns: [
      { key: 'name', label: 'Name' }, { key: 'code', label: 'Code' },
      { key: 'accrual_method', label: 'Accrual' },
      { key: 'annual_quota', label: 'Annual quota', align: 'right' },
      { key: 'max_carry_forward', label: 'Max carry fwd', align: 'right' },
      { key: 'is_paid', label: 'Paid', render: (r) => r.is_paid ? 'Yes' : 'No (LOP)' },
      { key: 'active', label: 'Active', render: (r) => r.active ? 'Yes' : 'No' },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'code', label: 'Code', required: true },
      { key: 'accrual_method', label: 'Accrual method', type: 'select', options: [
        { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' },
        { value: 'on_joining', label: 'On joining' }, { value: 'none', label: 'None' }] },
      { key: 'accrual_count', label: 'Accrual per period', type: 'number' },
      { key: 'annual_quota', label: 'Annual quota (days)', type: 'number' },
      { key: 'max_carry_forward', label: 'Max carry forward', type: 'number' },
      { key: 'min_notice_days', label: 'Min notice days', type: 'number' },
      { key: 'max_consecutive_days', label: 'Max consecutive days (0 = ∞)', type: 'number' },
      { key: 'applicable_gender', label: 'Applicable gender', type: 'select', options: [{ value: 'all', label: 'All' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] },
      { key: 'sandwich_rule', label: 'Sandwich rule', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'include_holidays', label: 'Include holidays' }] },
      { key: 'is_paid', label: 'Paid leave', type: 'check' },
      { key: 'encashable', label: 'Encashable', type: 'check' },
      { key: 'negative_balance_allowed', label: 'Allow negative balance', type: 'check' },
      { key: 'active', label: 'Active', type: 'check' },
    ],
  },
  'expense-categories': {
    title: 'Expense categories', singular: 'category',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'monthly_limit', label: 'Monthly limit', align: 'right', render: (r) => (r.monthly_limit ? '₹' + Number(r.monthly_limit).toLocaleString('en-IN') : '—') },
      { key: 'receipt_required_above', label: 'Receipt above', align: 'right', render: (r) => (r.receipt_required_above ? '₹' + Number(r.receipt_required_above).toLocaleString('en-IN') : '—') },
      { key: 'active', label: 'Active', render: (r) => r.active ? 'Yes' : 'No' },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'monthly_limit', label: 'Monthly limit (₹)', type: 'number' },
      { key: 'receipt_required_above', label: 'Receipt required above (₹)', type: 'number' },
      { key: 'active', label: 'Active', type: 'check' },
    ],
  },
  'letter-templates': {
    title: 'Letter templates', singular: 'template',
    columns: [{ key: 'name', label: 'Name' }, { key: 'ltype', label: 'Type' }, { key: 'subject', label: 'Subject' }, { key: 'active', label: 'Active', render: (r) => r.active ? 'Yes' : 'No' }],
    fields: [
      { key: 'name', label: 'Template name', required: true },
      { key: 'ltype', label: 'Type', type: 'select', options: ['offer', 'appointment', 'confirmation', 'promotion', 'increment', 'experience', 'relieving', 'warning', 'custom'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) },
      { key: 'subject', label: 'Subject' },
      { key: 'body', label: 'Body', type: 'textarea', rows: 8, hint: 'Merge fields: {{employeeName}}, {{employeeCode}}, {{designation}}, {{department}}, {{companyName}}, {{joiningDate}}, {{today}}, {{ctc}}' },
      { key: 'active', label: 'Active', type: 'check' },
    ],
  },
  customers: {
    title: 'Customers', singular: 'customer',
    columns: [{ key: 'name', label: 'Name' }, { key: 'gstin', label: 'GSTIN' }, { key: 'state', label: 'State' }, { key: 'email', label: 'Email' }, { key: 'status', label: 'Status' }],
    fields: [
      { key: 'name', label: 'Name', required: true }, { key: 'gstin', label: 'GSTIN' },
      { key: 'address', label: 'Address' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'state_code', label: 'State code', hint: 'e.g. KA, MH — determines CGST/SGST vs IGST' },
      { key: 'pincode', label: 'Pincode' }, { key: 'contact_name', label: 'Contact person' },
      { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
      { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ],
  },
};

const ORG_TABS = [
  ['departments', 'Departments'], ['designations', 'Designations'], ['grades', 'Grades'],
  ['locations', 'Locations'], ['cost-centers', 'Cost centers'], ['shifts', 'Shifts'],
];
const OTHER_TABS = [
  ['leave-types', 'Leave types'], ['expense-categories', 'Expense categories'],
  ['letter-templates', 'Letter templates'], ['customers', 'Customers'],
];

export default function OrgPage() {
  const { resource } = useParams();
  const [lookups, setLookups] = useState(null);
  useEffect(() => {
    api.get('/org/lookups').then(({ data }) => setLookups(data.data)).catch(() => {});
  }, []);

  const cfg = RESOURCES[resource];
  const isOrg = ORG_TABS.some(([k]) => k === resource);
  const tabs = isOrg ? ORG_TABS : OTHER_TABS;

  if (!cfg) return <div className="card" style={{ padding: 30 }}>Unknown resource.</div>;

  // resolve select options that reference lookups
  const fields = cfg.fields.map((f) =>
    f.options === 'grades'
      ? { ...f, options: (lookups?.grades || []).map((g) => ({ value: g.id, label: g.name })) }
      : f
  );

  return (
    <div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {tabs.map(([key, label]) => (
          <NavLink key={key} to={`/org/${key}`} className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>{label}</NavLink>
        ))}
        {isOrg && <Link to="/leave/holidays" className="tab" style={{ marginLeft: 'auto', color: 'var(--primary)' }}>Holidays →</Link>}
      </div>
      <h2 style={{ fontSize: 17, marginBottom: 14 }}>{cfg.title}</h2>
      <CrudPage key={resource} resource={resource} title={cfg.title} singular={cfg.singular} fields={fields} columns={cfg.columns} />
    </div>
  );
}
