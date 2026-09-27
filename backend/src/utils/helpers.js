const dayjs = require('dayjs');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wrap async route handlers so rejections hit the error middleware. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "YYYY-MM-DD" for a Date/dayjs (server-local). */
const iso = (d) => dayjs(d).format('YYYY-MM-DD');

function monthRange(year, month) {
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  return { start: start.format('YYYY-MM-DD'), end: start.endOf('month').format('YYYY-MM-DD'), daysInMonth: start.daysInMonth() };
}

function fyLabel(date = new Date()) {
  const d = dayjs(date);
  const y = d.month() >= 3 ? d.year() : d.year() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Pick only listed keys (strings) from an object; trims strings. */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) {
      out[k] = typeof obj[k] === 'string' ? obj[k].trim() : obj[k];
      if (out[k] === '') out[k] = null;
    }
  }
  return out;
}

const INDIAN_STATES = [
  { code: 'AP', name: 'Andhra Pradesh' }, { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' }, { code: 'BR', name: 'Bihar' }, { code: 'CT', name: 'Chhattisgarh' },
  { code: 'GA', name: 'Goa' }, { code: 'GJ', name: 'Gujarat' }, { code: 'HR', name: 'Haryana' },
  { code: 'HP', name: 'Himachal Pradesh' }, { code: 'JH', name: 'Jharkhand' }, { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' }, { code: 'MP', name: 'Madhya Pradesh' }, { code: 'MH', name: 'Maharashtra' },
  { code: 'MN', name: 'Manipur' }, { code: 'ML', name: 'Meghalaya' }, { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' }, { code: 'OD', name: 'Odisha' }, { code: 'PB', name: 'Punjab' },
  { code: 'RJ', name: 'Rajasthan' }, { code: 'SK', name: 'Sikkim' }, { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TG', name: 'Telangana' }, { code: 'TR', name: 'Tripura' }, { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UK', name: 'Uttarakhand' }, { code: 'WB', name: 'West Bengal' }, { code: 'DL', name: 'Delhi' },
  { code: 'JK', name: 'Jammu & Kashmir' }, { code: 'LA', name: 'Ladakh' },
  { code: 'AN', name: 'Andaman & Nicobar' }, { code: 'CH', name: 'Chandigarh' },
  { code: 'DH', name: 'Dadra & Nagar Haveli and Daman & Diu' }, { code: 'DD', name: 'Daman & Diu' },
  { code: 'PY', name: 'Puducherry' }, { code: 'LD', name: 'Lakshadweep' },
];

module.exports = { HttpError, asyncH, round2, inr, iso, monthRange, fyLabel, pick, INDIAN_STATES, dayjs };
