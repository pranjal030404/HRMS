// Restricted safe expression engine for payroll formulas.
// Supports: numbers, identifiers (component codes), + - * / %, parentheses,
// comparisons (< <= > >= == !=), ternary (a ? b : c), && / ||, and functions
// min, max, round, ceil, floor, abs, if. No JS evaluation of user input.

const FUNCS = {
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  round: { arity: 2, fn: (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d },
  round0: { arity: 1, fn: (v) => Math.round(v) },
  ceil: { arity: 1, fn: Math.ceil },
  floor: { arity: 1, fn: Math.floor },
  abs: { arity: 1, fn: Math.abs },
  if: { arity: 3, fn: (c, a, b) => (c ? a : b) },
};

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      toks.push({ t: 'op', v: two }); i += 2; continue;
    }
    if ('+-*/%()?:<>,!'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`Invalid character '${ch}' in formula`);
  }
  return toks;
}

function parse(tokens, vars) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v) => {
    const tk = tokens[pos];
    if (!tk || tk.t !== 'op' || tk.v !== v) throw new Error(`Expected '${v}' in formula`);
    pos++;
  };

  function ternary() {
    const cond = orExpr();
    if (peek() && peek().t === 'op' && peek().v === '?') {
      eat('?');
      const a = ternary();
      eat(':');
      const b = ternary();
      return cond ? a : b;
    }
    return cond;
  }
  function orExpr() {
    let left = andExpr();
    while (peek() && peek().v === '||') { pos++; left = andExpr() || left; }
    return left ? 1 : 0;
  }
  function andExpr() {
    let left = cmpExpr();
    while (peek() && peek().v === '&&') { pos++; left = cmpExpr() && left; }
    return left ? 1 : 0;
  }
  function cmpExpr() {
    let left = addExpr();
    while (peek() && peek().t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(peek().v)) {
      const op = tokens[pos++].v;
      const right = addExpr();
      switch (op) {
        case '<': left = left < right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
      }
    }
    return left;
  }
  function addExpr() {
    let left = mulExpr();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[pos++].v;
      const right = mulExpr();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function mulExpr() {
    let left = unary();
    while (peek() && peek().t === 'op' && ['*', '/', '%'].includes(peek().v)) {
      const op = tokens[pos++].v;
      const right = unary();
      if (op === '*') left *= right;
      else if (op === '/') { if (right === 0) throw new Error('Division by zero in formula'); left /= right; }
      else left %= right;
    }
    return left;
  }
  function unary() {
    if (peek() && peek().t === 'op' && peek().v === '-') { pos++; return -unary(); }
    return primary();
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end of formula');
    if (tk.t === 'num') { pos++; return tk.v; }
    if (tk.t === 'ident') {
      pos++;
      const name = tk.v.toUpperCase();
      // function call
      if (peek() && peek().t === 'op' && peek().v === '(') {
        const fn = FUNCS[tk.v.toLowerCase()];
        if (!fn) throw new Error(`Unknown function '${tk.v}'`);
        eat('(');
        const args = [];
        if (peek() && !(peek().t === 'op' && peek().v === ')')) {
          args.push(ternary());
          while (peek() && peek().t === 'op' && peek().v === ',') { pos++; args.push(ternary()); }
        }
        eat(')');
        return fn.fn(...args);
      }
      if (tk.v.toLowerCase() === 'true') return 1;
      if (tk.v.toLowerCase() === 'false') return 0;
      const key = Object.keys(vars).find((k) => k.toUpperCase() === name);
      if (key === undefined) throw new Error(`Unknown variable '${tk.v}'`);
      return Number(vars[key]) || 0;
    }
    if (tk.t === 'op' && tk.v === '(') { pos++; const v = ternary(); eat(')'); return v; }
    throw new Error(`Unexpected token '${tk.v}' in formula`);
  }

  const result = ternary();
  if (pos < tokens.length) throw new Error('Unexpected trailing tokens in formula');
  if (!isFinite(result)) throw new Error('Formula produced non-finite result');
  return result;
}

/** Evaluate a payroll formula safely against a variable map. Throws on invalid input. */
function evalFormula(expr, vars = {}) {
  if (expr === null || expr === undefined || String(expr).trim() === '') return 0;
  return parse(tokenize(String(expr)), vars);
}

/** Validate a formula without variables (used on save). Unknown vars allowed. */
function validateFormula(expr) {
  try {
    evalFormula(expr, { __PROBE__: 1, BASIC: 1, GROSS: 1, CTC: 1, PAYABLE_DAYS: 1, MONTH_DAYS: 1, LOP_DAYS: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { evalFormula, validateFormula };
