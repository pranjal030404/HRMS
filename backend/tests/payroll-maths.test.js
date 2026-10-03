/**
 * Pure payroll / statutory arithmetic. No database needed.
 *   node --test tests/payroll-maths.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unpaidLeaveDaysInRange } = require('../src/services/attendance');
const { daysOutsideEmployment } = require('../src/services/payroll');
const { annualIncomeTax, ptTax } = require('../src/services/statutory');

test('unpaid leave spanning two months is split, not charged in full to both', () => {
  const req = [{ start_date: '2026-01-29', end_date: '2026-02-03', days: 6 }];
  const jan = unpaidLeaveDaysInRange(req, '2026-01-01', '2026-01-31');
  const feb = unpaidLeaveDaysInRange(req, '2026-02-01', '2026-02-28');
  assert.equal(jan, 3);
  assert.equal(feb, 3);
  assert.equal(jan + feb, 6);
});

test('the per-day breakdown wins and ignores weekends/holidays', () => {
  const req = [{
    start_date: '2026-01-30', end_date: '2026-02-02', days: 2,
    day_breakdown: [
      { date: '2026-01-30', value: 1, kind: 'working' }, { date: '2026-01-31', value: 0, kind: 'week_off' },
      { date: '2026-02-01', value: 0, kind: 'week_off' }, { date: '2026-02-02', value: 1, kind: 'working' },
    ],
  }];
  assert.equal(unpaidLeaveDaysInRange(req, '2026-01-01', '2026-01-31'), 1);
  assert.equal(unpaidLeaveDaysInRange(req, '2026-02-01', '2026-02-28'), 1);
});

test('mid-month joiners and leavers are not paid for days they were not employed', () => {
  const base = { monthStart: '2026-04-01', monthEnd: '2026-04-30', daysInMonth: 30, monthDays: 30 };
  assert.equal(daysOutsideEmployment({ ...base, joinedOn: '2026-04-21' }), 20);
  assert.equal(daysOutsideEmployment({ ...base, joinedOn: '2026-04-01' }), 0);
  assert.equal(daysOutsideEmployment({ ...base, joinedOn: '2025-01-01' }), 0);
  assert.equal(daysOutsideEmployment({ ...base, joinedOn: '2025-01-01', exitDate: '2026-04-10' }), 20);
  assert.equal(daysOutsideEmployment({ ...base, joinedOn: '2025-01-01', exitDate: '2026-04-30' }), 0);
  // a fixed 26-day payroll month scales the same calendar gap
  assert.equal(daysOutsideEmployment({ ...base, monthDays: 26, joinedOn: '2026-04-16' }), 13);
});

test('surcharge uses the single highest threshold crossed and is not compounded', () => {
  const params = {
    slabs: [{ upto: 1000000, rate: 10 }, { above: true, rate: 30 }],
    surchargeSlabs: [{ above: 5000000, rate: 10 }, { above: 10000000, rate: 15 }], cess: 0,
  };
  const base = annualIncomeTax(4000000, { ...params, surchargeSlabs: [] });
  const high = annualIncomeTax(12000000, { ...params, surchargeSlabs: [] });
  assert.ok(Math.abs(annualIncomeTax(12000000, params) - high * 1.15) < 0.01, 'only the 15% band applies');
  assert.ok(Math.abs(annualIncomeTax(6000000, params) - annualIncomeTax(6000000, { ...params, surchargeSlabs: [] }) * 1.10) < 0.01);
  assert.equal(annualIncomeTax(4000000, params), base);
});

test('income tax rebate and cess behave', () => {
  const p = { slabs: [{ upto: 300000, rate: 0 }, { upto: 700000, rate: 5 }, { above: true, rate: 10 }], rebateLimit: 700000, rebateAmount: 20000, cess: 4 };
  assert.equal(annualIncomeTax(700000, p), 0, 'inside the rebate limit the tax is wiped out');
  assert.ok(annualIncomeTax(800000, p) > 0);
});

test('professional tax picks the bracket the gross falls in', () => {
  const p = { slabs: [{ upto: 15000, tax: 0 }, { upto: 25000, tax: 150 }, { above: true, tax: 200 }] };
  assert.equal(ptTax(p, 12000), 0);
  assert.equal(ptTax(p, 20000), 150);
  assert.equal(ptTax(p, 90000), 200);
});
