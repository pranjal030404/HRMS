const { pool } = require('../config/db');
const { round2 } = require('../utils/helpers');

/**
 * Versioned statutory rules. Every lookup is effective-dated so historical payroll
 * can be reproduced with the rule version that was active at that time.
 * Params JSON shapes (all editable per tenant):
 *  PF  : { employeeRate, employerRate, epsRate, wageCeiling, capAtCeiling }
 *  ESI : { employeeRate, employerRate, grossCeiling }
 *  PT  : { slabs: [{ upto, tax }..., { above: true, tax }] }
 *  TDS : { slabs: [{ upto, rate }..., { above: true, rate }], stdDeduction, rebateLimit, rebateAmount, cess }
 *  LWF : { employeeAmount, employerAmount }
 */
/**
 * `locations.state` stores a human-readable name ('Karnataka') while statutory rules are keyed
 * by the ISO-3166 code ('KA'). Without this bridge a state-specific rule silently never matches
 * and PT computes as zero for everyone.
 */
const STATE_CODES = {
  'andhra pradesh': 'AP', 'arunachal pradesh': 'AR', assam: 'AS', bihar: 'BR', chhattisgarh: 'CG',
  goa: 'GA', gujarat: 'GJ', haryana: 'HR', 'himachal pradesh': 'HP', jharkhand: 'JH',
  karnataka: 'KA', kerala: 'KL', 'madhya pradesh': 'MP', maharashtra: 'MH', manipur: 'MN',
  meghalaya: 'ML', mizoram: 'MZ', nagaland: 'NL', odisha: 'OD', punjab: 'PB', rajasthan: 'RJ',
  sikkim: 'SK', 'tamil nadu': 'TN', telangana: 'TG', tripura: 'TR', 'uttar pradesh': 'UP',
  uttarakhand: 'UK', 'west bengal': 'WB', delhi: 'DL', 'new delhi': 'DL',
  'jammu and kashmir': 'JK', ladakh: 'LA', puducherry: 'PY', 'andaman and nicobar islands': 'AN',
  'dadra and nagar haveli and daman and diu': 'DH', 'lakshadweep islands': 'LD',
};

/** Rule lookup preference: exact value, then its ISO code, then the national fallback. */
function jurisdictionCandidates(jurisdiction) {
  if (!jurisdiction) return ['IN'];
  const raw = String(jurisdiction).trim();
  const code = STATE_CODES[raw.toLowerCase()] || raw.toUpperCase();
  return [...new Set([raw, code, 'IN'].filter(Boolean))];
}

async function getRule(tenantId, ruleType, onDate, jurisdiction = 'IN') {
  const cands = jurisdictionCandidates(jurisdiction);
  const holes = cands.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM statutory_rules
     WHERE tenant_id = ? AND rule_type = ? AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
       AND jurisdiction IN (${holes})
     ORDER BY FIELD(jurisdiction, ${holes}) ASC, effective_from DESC LIMIT 1`,
    [tenantId, ruleType, onDate, onDate, ...cands, ...cands]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return { ...r, params: typeof r.params === 'string' ? JSON.parse(r.params) : r.params, jurisdiction: r.jurisdiction };
}

function slabTax(amount, slabs) {
  let tax = 0;
  let prev = 0;
  for (const s of slabs) {
    if (s.above) { tax += ((amount - prev) * s.rate) / 100; break; }
    if (amount > (s.upto ?? 0)) tax += ((Math.min(amount, s.upto) - prev) * (s.rate ?? 0)) / 100 + (s.tax || 0) * 0;
    // slabs may carry flat `tax` instead of rate for PT-style brackets
    if (s.rate === undefined && s.tax !== undefined) {
      tax = 0; // recompute flat-mode
      let p = 0;
      for (const q of slabs) {
        if (q.above) { tax += q.tax; break; }
        if (amount > p) { tax = q.tax; } // flat tax of the highest bracket crossed
        p = q.upto ?? p;
      }
      return tax;
    }
    prev = s.upto ?? 0;
    if (amount <= (s.upto ?? Infinity)) break;
  }
  return tax;
}

function ptTax(params, gross) {
  if (!params?.slabs) return 0;
  for (const s of params.slabs) {
    if (s.above) return s.tax || 0;
    if (gross <= (s.upto ?? 0)) return s.tax || 0;
  }
  return 0;
}

function annualIncomeTax(annualTaxable, params) {
  if (!params?.slabs) return 0;
  let tax = 0;
  let prev = 0;
  for (const s of params.slabs) {
    const upto = s.above ? Infinity : s.upto;
    if (annualTaxable > prev) tax += ((Math.min(annualTaxable, upto) - prev) * s.rate) / 100;
    prev = upto;
    if (annualTaxable <= upto) break;
  }
  if (params.rebateLimit && annualTaxable <= params.rebateLimit && tax > 0) {
    tax = Math.max(0, tax - (params.rebateAmount || 0));
  }
  // surcharge (optional simple thresholds)
  // Only the highest threshold crossed applies. The old loop added every matching
  // slab on top of the already-surcharged tax, so income above two thresholds was taxed
  // at the two rates compounded rather than at the higher one.
  if (params.surchargeSlabs) {
    const hit = params.surchargeSlabs.filter((sc) => annualTaxable > sc.above).sort((a, b) => b.above - a.above)[0];
    if (hit) tax += (tax * hit.rate) / 100;
  }
  tax += (tax * (params.cess ?? 4)) / 100;
  return tax;
}

/**
 * Compute all statutory components for one employee-month.
 * Returns { pfEmployee, pfEmployer, pfEps, esiEmployee, esiEmployer, pt, tds, lwfEmployee, lwfEmployer, breakdown }
 */
async function computeStatutory({ tenantId, onDate, jurisdiction = 'IN', gross, basic, taxRegime = 'new', annualDeclarations = 0, pfWage = null }) {
  const out = { pfEmployee: 0, pfEmployer: 0, pfEps: 0, esiEmployee: 0, esiEmployer: 0, pt: 0, tds: 0, lwfEmployee: 0, lwfEmployer: 0 };
  const breakdown = {};

  const pfRule = await getRule(tenantId, 'PF', onDate, jurisdiction);
  if (pfRule && pfRule.params) {
    const p = pfRule.params;
    const wage = pfWage !== null ? pfWage : basic;
    const capped = p.capAtCeiling ? Math.min(wage, p.wageCeiling || wage) : wage;
    out.pfEmployee = round2((capped * (p.employeeRate || 0)) / 100);
    out.pfEmployer = round2((capped * (p.employerRate || 0)) / 100);
    out.pfEps = round2((Math.min(capped, p.wageCeiling || capped) * (p.epsRate || 0)) / 100);
    breakdown.pf = { ruleVersion: pfRule.version, pfWage: capped };
  }

  const esiRule = await getRule(tenantId, 'ESI', onDate, jurisdiction);
  if (esiRule && esiRule.params && gross > 0 && gross <= (esiRule.params.grossCeiling || 0)) {
    const p = esiRule.params;
    out.esiEmployee = round2((gross * (p.employeeRate || 0)) / 100);
    out.esiEmployer = round2((gross * (p.employerRate || 0)) / 100);
    breakdown.esi = { ruleVersion: esiRule.version };
  }

  const ptRule = await getRule(tenantId, 'PT', onDate, jurisdiction);
  if (ptRule && ptRule.params) {
    out.pt = ptTax(ptRule.params, gross);
    breakdown.pt = { ruleVersion: ptRule.version, jurisdiction: ptRule.jurisdiction || jurisdiction };
  }

  const tdsRule = await getRule(tenantId, 'TDS', onDate, 'IN');
  if (tdsRule && tdsRule.params) {
    const p = tdsRule.params;
    const annualGross = gross * 12;
    const regimeParams = taxRegime === 'old' && p.old ? p.old : p;
    const taxable = Math.max(0, annualGross - (regimeParams.stdDeduction || 0) - (taxRegime === 'old' ? annualDeclarations : 0));
    const annualTax = annualIncomeTax(taxable, regimeParams);
    out.tds = round2(annualTax / 12);
    breakdown.tds = { ruleVersion: tdsRule.version, regime: taxRegime, projectedAnnualTaxable: Math.round(taxable), projectedAnnualTax: Math.round(annualTax) };
  }

  const lwfRule = await getRule(tenantId, 'LWF', onDate, jurisdiction);
  if (lwfRule && lwfRule.params) {
    out.lwfEmployee = lwfRule.params.employeeAmount || 0;
    out.lwfEmployer = lwfRule.params.employerAmount || 0;
    breakdown.lwf = { ruleVersion: lwfRule.version };
  }

  return { ...out, breakdown };
}

module.exports = { getRule, computeStatutory, slabTax, ptTax, annualIncomeTax, jurisdictionCandidates, STATE_CODES };
