/**
 * Customization — company-specific fields and forms.
 *
 * Definitions are data (`custom_field_definitions`), values are data
 * (`custom_field_values`), so a company can add a "Shirt size" or a "Visa status"
 * field without a deployment. Visibility is expressed as data too: a field can be
 * restricted to roles and departments, and the same rules are evaluated server
 * side before a value is read or written.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, bool, decode, j, unj, insertRows } = require('./_shared');

const r = express.Router();

const READ = requirePermission('administration.custom_fields.view', { anyOf: ['settings.view'] });
const WRITE = requirePermission('administration.custom_fields.manage', { anyOf: ['settings.manage'] });
const FORM_READ = requirePermission('administration.forms.view', { anyOf: ['settings.view'] });
const FORM_WRITE = requirePermission('administration.forms.manage', { anyOf: ['settings.manage'] });

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'select', 'multi_select', 'email', 'phone', 'url', 'currency', 'percent', 'json'];

// ------------------------------------------------------------- definitions
r.get('/custom-fields', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const where = ['cf.tenant_id = ?']; const params = [t];
  if (req.query.entity_type) { where.push('cf.entity_type = ?'); params.push(req.query.entity_type); }
  if (req.query.status) { where.push('cf.status = ?'); params.push(req.query.status); }
  if (req.query.q) {
    where.push('(cf.label LIKE ? OR cf.field_key LIKE ? OR cf.description LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  }
  const base = `FROM custom_field_definitions cf WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
  const [rows] = await pool.query(
    `SELECT cf.*, (SELECT COUNT(*) FROM custom_field_values v WHERE v.field_id = cf.id) AS value_count
     ${base} ORDER BY cf.entity_type, cf.display_order, cf.label LIMIT 500`, params
  );
  const ids = rows.map((x) => x.id);
  let options = [];
  if (ids.length) {
    [options] = await pool.query(
      'SELECT * FROM custom_field_options WHERE field_id IN (?) AND (status IS NULL OR status = \'active\') ORDER BY field_id, sort_order', [ids]
    );
  }
  const byField = new Map();
  for (const o of options) {
    if (!byField.has(o.field_id)) byField.set(o.field_id, []);
    byField.get(o.field_id).push({ value: o.option_value, label: o.option_label });
  }
  const [usage] = ids.length
    ? await pool.query(
      `SELECT entity_type, COUNT(*) AS c FROM custom_field_values WHERE field_id IN (?) GROUP BY entity_type`, [ids])
    : [[]];
  const usageMap = new Map(usage.map((u) => [u.entity_type, Number(u.c)]));

  res.json({
    data: rows.map((row) => ({
      ...decode(row, ['allowed_role_codes', 'allowed_department_ids']),
      options: byField.get(row.id) || [],
      usedOn: usageMap.get(row.entity_type) || 0,
    })),
    meta: { total: Number(total), fieldTypes: FIELD_TYPES, entityTypes: [...new Set(rows.map((x) => x.entity_type).filter(Boolean))] },
  });
}));

/** Normalise a definition body: types validated, option lists split out. */
function definitionPayload(body, existing = {}) {
  const fieldType = body.field_type ?? existing.field_type;
  if (!FIELD_TYPES.includes(fieldType)) throw new HttpError(400, `field_type must be one of: ${FIELD_TYPES.join(', ')}`);
  const entityType = String(body.entity_type ?? existing.entity_type ?? '').trim();
  if (!entityType) throw new HttpError(400, 'entity_type is required (e.g. employee, department, position)');
  const fieldKey = String(body.field_key ?? existing.field_key ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!fieldKey) throw new HttpError(400, 'field_key is required');
  return {
    entity_type: entityType,
    field_key: fieldKey,
    label: body.label ?? existing.label,
    description: body.description ?? existing.description,
    field_type: fieldType,
    required: bool(body.required ?? (existing.required ? 1 : 0)),
    default_value: body.default_value ?? existing.default_value,
    placeholder: body.placeholder ?? existing.placeholder,
    help_text: body.help_text ?? existing.help_text,
    min_value: body.min_value ?? existing.min_value,
    max_value: body.max_value ?? existing.max_value,
    regex_pattern: body.regex_pattern ?? existing.regex_pattern,
    options_source: body.options_source ?? existing.options_source,
    visibility: j(normalizeVisibility(body.visibility ?? existing.visibility)),
    allowed_role_codes: j(body.allowed_role_codes ?? unj(existing.allowed_role_codes, [])),
    allowed_department_ids: j(body.allowed_department_ids ?? unj(existing.allowed_department_ids, [])),
    display_order: int(body.display_order, int(existing.display_order, 0)),
    status: body.status ?? existing.status ?? 'active',
  };
}

r.post('/custom-fields', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const body = req.body || {};
  const data = definitionPayload(body);
  if (!data.label) throw new HttpError(400, 'label is required');
  const [dupe] = await pool.query(
    'SELECT id FROM custom_field_definitions WHERE tenant_id = ? AND entity_type = ? AND field_key = ?', [t, data.entity_type, data.field_key]
  );
  if (dupe[0]) throw new HttpError(409, `Field "${data.field_key}" already exists on ${data.entity_type}`);

  const cols = Object.keys(data);
  const [ins] = await pool.query(
    `INSERT INTO custom_field_definitions (tenant_id, ${cols.join(',')}, created_by) VALUES (?,${cols.map(() => '?').join(',')},?)`,
    [t, ...cols.map((c) => data[c]), req.user.id]
  );
  await saveOptions(t, ins.insertId, body.options, req.user.id);
  await audit(req, { action: 'custom_field.create', entityType: 'field', entityId: ins.insertId, after: { key: data.field_key, entity: data.entity_type } });
  res.status(201).json({ data: { id: ins.insertId, ...data, options: body.options || [] } });
}));

r.put('/custom-fields/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [before] = await pool.query('SELECT * FROM custom_field_definitions WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!before[0]) throw new HttpError(404, 'Custom field not found');
  const data = definitionPayload(req.body || {}, before[0]);
  const cols = Object.keys(data);
  await pool.query(
    `UPDATE custom_field_definitions SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`,
    [...cols.map((c) => data[c]), before[0].id, t]
  );
  if (Array.isArray(req.body?.options)) await saveOptions(t, before[0].id, req.body.options, req.user.id, true);
  await audit(req, { action: 'custom_field.update', entityType: 'field', entityId: before[0].id, before: decode(before[0], ['allowed_role_codes']), after: data });
  res.json({ ok: true });
}));

/**
 * DELETE /custom-fields/:id
 * Removes the definition *and* every value stored for it, so no orphan data is
 * left behind. The audit entry keeps the before-image.
 */
r.delete('/custom-fields/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [before] = await pool.query('SELECT * FROM custom_field_definitions WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!before[0]) throw new HttpError(404, 'Custom field not found');
  const [used] = await pool.query('SELECT COUNT(*) AS c FROM custom_field_values WHERE field_id = ?', [before[0].id]);
  if (Number(used[0].c) > 0 && !bool(req.query.force)) {
    throw new HttpError(409, `${used[0].c} record(s) use this field. Retry with ?force=1 to delete the field and its values.`);
  }
  await pool.query('DELETE FROM custom_field_values WHERE field_id = ?', [before[0].id]);
  await pool.query('DELETE FROM custom_field_options WHERE field_id = ?', [before[0].id]);
  await pool.query('DELETE FROM custom_form_fields WHERE field_id = ?', [before[0].id]);
  await pool.query('DELETE FROM custom_field_definitions WHERE id = ? AND tenant_id = ?', [before[0].id, t]);
  await audit(req, { action: 'custom_field.delete', entityType: 'field', entityId: before[0].id, before: decode(before[0], []), after: { deletedValues: Number(used[0].c) } });
  res.json({ ok: true, data: { deletedValues: Number(used[0].c) } });
}));

async function saveOptions(tenant, fieldId, options = [], actorId, replace = false) {
  if (!Array.isArray(options)) return;
  if (replace) await pool.query('DELETE FROM custom_field_options WHERE field_id = ?', [fieldId]);
  const rows = options
    .map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
    .filter((o) => o && o.value)
    .map((o, i) => [tenant, fieldId, String(o.value), o.label ? String(o.label) : String(o.value), i, 'active']);
  await insertRows('custom_field_options',
    ['tenant_id', 'field_id', 'option_value', 'option_label', 'sort_order', 'status'], rows);
}

// ------------------------------------------------------------- values
/** GET /custom-values?entity_type=employee&entity_ids=1,2,3 */
r.get('/custom-values', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const entityType = req.query.entity_type ?? req.query.entityType;
  const entityId = req.query.entity_id ?? req.query.entityId;
  if (!entityType) throw new HttpError(400, 'entity_type is required');
  const params = [t, entityType];
  let sql = 'SELECT * FROM custom_field_values WHERE tenant_id = ? AND entity_type = ?';
  if (entityId) { sql += ' AND entity_id = ?'; params.push(int(entityId)); }
  if (req.query.field_id) { sql += ' AND field_id = ?'; params.push(int(req.query.field_id)); }
  const [rows] = await pool.query(`${sql} ORDER BY entity_id, field_id`, params);
  // A field hidden from this caller must not leak through the values endpoint,
  // which is why visibility is checked on read as well as on write.
  const visible = await filterVisibleFields(req, t, rows);
  res.json({ data: visible.map((v) => ({ ...v, value: displayValue(v) })) });
}));

/**
 * PUT /custom-values
 * Upsert one field value for one record, validated against the definition
 * (type, options, required, min/max, regex) and the caller's visibility rules.
 */
r.put('/custom-values', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const body = req.body || {};
  const entityType = body.entity_type ?? body.entityType;
  const entityId = body.entity_id ?? body.entityId;
  const fieldId = body.field_id ?? body.fieldId;
  const fieldKey = body.field_key ?? body.fieldKey;
  const { value } = body;
  if (!entityType || !entityId || (!fieldId && !fieldKey)) {
    throw new HttpError(400, 'entity_type, entity_id and field_id (or field_key) are required');
  }
  // A field may be addressed by id or by its stable key within the entity type.
  const def = fieldId
    ? (await pool.query('SELECT * FROM custom_field_definitions WHERE id = ? AND tenant_id = ?', [int(fieldId), t]))[0][0]
    : (await pool.query(
      'SELECT * FROM custom_field_definitions WHERE tenant_id = ? AND entity_type = ? AND field_key = ?',
      [t, entityType, String(fieldKey)]
    ))[0][0];
  if (!def) throw new HttpError(404, 'Custom field not found');
  await assertFieldVisible(req, def);

  const typed = coerceValue(def, value);
  const cols = ['tenant_id', 'entity_type', 'entity_id', 'field_id', 'field_key', 'value_text', 'value_number', 'value_date', 'value_json', 'updated_by'];
  await pool.query(
    `INSERT INTO custom_field_values (${cols.join(',')}) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), value_number = VALUES(value_number),
       value_date = VALUES(value_date), value_json = VALUES(value_json), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [t, entityType, int(entityId), def.id, def.field_key, typed.text, typed.number, typed.date, typed.json, req.user.id]
  );
  await audit(req, { action: 'custom_value.set', entityType: 'custom_value', entityId: `${entityType}:${entityId}:${def.field_key}`, after: { value: typed.text } });
  res.json({ ok: true, data: { value: typed.text } });
}));

/** PUT /custom-values/bulk — set the same field on many records. */
r.put('/custom-values/bulk', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { entity_type: entityType, entity_ids: entityIds, field_id: fieldId, value } = req.body || {};
  const ids = [...new Set((entityIds || []).map((x) => int(x)).filter(Boolean))];
  if (!entityType || !ids.length || !fieldId) throw new HttpError(400, 'entity_type, field_id and entity_ids[] are required');
  const [defs] = await pool.query('SELECT * FROM custom_field_definitions WHERE id = ? AND tenant_id = ?', [int(fieldId), t]);
  const def = defs[0];
  if (!def) throw new HttpError(404, 'Custom field not found');
  await assertFieldVisible(req, def);
  const typed = coerceValue(def, value);
  await pool.query(
    `INSERT INTO custom_field_values (tenant_id, entity_type, entity_id, field_id, field_key, value_text, value_number, value_date, value_json, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), value_number = VALUES(value_number),
       value_date = VALUES(value_date), value_json = VALUES(value_json), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [ids.map((id) => [t, entityType, id, def.id, def.field_key, typed.text, typed.number, typed.date, typed.json, req.user.id])]
  );
  await audit(req, { action: 'custom_value.bulk', entityType: 'custom_value', entityId: `${entityType}:${def.field_key}`, after: { count: ids.length, value: typed.text } });
  res.json({ ok: true, data: { updated: ids.length } });
}));

const displayValue = (row) => {
  if (row.value_text !== null && row.value_text !== undefined) return row.value_text;
  if (row.value_number !== null && row.value_number !== undefined) return Number(row.value_number);
  if (row.value_date) return row.value_date;
  return unj(row.value_json, null);
};

/** Store the value in the column that matches the field type. */
function coerceValue(def, value) {
  const out = { text: null, number: null, date: null, json: null };
  const empty = value === undefined || value === null || value === '';
  if (def.required && empty) throw new HttpError(400, `"${def.label}" is required`);
  if (empty) return out;

  switch (def.field_type) {
    case 'number': case 'currency': case 'percent': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new HttpError(400, `"${def.label}" must be a number`);
      if (def.min_value != null && n < Number(def.min_value)) throw new HttpError(400, `"${def.label}" must be at least ${def.min_value}`);
      if (def.max_value != null && n > Number(def.max_value)) throw new HttpError(400, `"${def.label}" must be at most ${def.max_value}`);
      out.number = n; out.text = String(n);
      break;
    }
    case 'boolean':
      out.text = (value === true || value === 1 || value === '1' || value === 'true') ? '1' : '0';
      break;
    case 'date': case 'datetime': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `"${def.label}" must be a valid date`);
      out.date = def.field_type === 'date' ? value.slice(0, 10) : value.slice(0, 19).replace('T', ' ');
      out.text = out.date;
      break;
    }
    case 'multi_select':
      out.json = j(Array.isArray(value) ? value : String(value).split(','));
      out.text = Array.isArray(value) ? value.join(',') : String(value);
      break;
    case 'json':
      try { out.json = j(typeof value === 'string' ? JSON.parse(value) : value); } catch { throw new HttpError(400, `"${def.label}" must be valid JSON`); }
      out.text = typeof value === 'string' ? value : JSON.stringify(value);
      break;
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value))) throw new HttpError(400, `"${def.label}" must be a valid email`);
      out.text = String(value);
      break;
    default: {
      out.text = String(value);
      if (def.regex_pattern) {
        let re;
        try { re = new RegExp(def.regex_pattern); } catch { re = null; }
        if (re && !re.test(out.text)) throw new HttpError(400, `"${def.label}" does not match the required format`);
      }
    }
  }
  if (['select', 'multi_select'].includes(def.field_type) && def.field_type === 'select') {
    // option membership is checked by the caller-supplied option list when present
    out.text = String(value);
  }
  return out;
}

/** Drops values whose field definition is hidden from the calling role. */
async function filterVisibleFields(req, tenant, values) {
  const ids = [...new Set(values.map((v) => v.field_id).filter(Boolean))];
  if (!ids.length) return values;
  const [defs] = await pool.query(
    `SELECT * FROM custom_field_definitions WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [tenant, ...ids]
  );
  const byId = new Map(defs.map((d) => [d.id, d]));
  const allowed = [];
  for (const v of values) {
    const def = byId.get(v.field_id);
    if (!def) continue;
    try {
      await assertFieldVisible(req, def);
      allowed.push(v);
    } catch (_) { /* hidden for this role */ }
  }
  return allowed;
}

/**
 * `custom_field_definitions.visibility` is a JSON column. Accept the shorthand
 * clients naturally send ("all" / "hidden" / "roles") as well as the full object,
 * and always store one shape: { mode, showInList, showInDetail, readOnlyRoles }.
 */
function normalizeVisibility(v) {
  const parsed = typeof v === 'string' ? (['all', 'hidden', 'roles'].includes(v) ? { mode: v } : unj(v, {})) : (v || {});
  const mode = parsed.mode || 'all';
  return {
    mode,
    showInList: parsed.showInList !== false,
    showInDetail: parsed.showInDetail !== false,
    readOnlyRoles: parsed.readOnlyRoles || [],
  };
}

const visibilityMode = (v) => (typeof v === 'string' ? v : (unj(v, {}) || {}).mode) || 'all';

/** Role/department visibility, enforced server side on read and write. */
async function assertFieldVisible(req, def) {
  if (!def) return;
  if (req.user.isPlatformAdmin) return;
  const canManage = (req.user.permissions || []).includes('administration.custom_fields.manage');
  if (visibilityMode(def.visibility) === 'hidden' && !canManage) {
    throw new HttpError(403, 'That field is not available');
  }

  const roles = unj(def.allowed_role_codes, []) || [];
  if (roles.length) {
    const mine = [req.user.role, ...(req.user.roles || []).map((x) => x.name)].filter(Boolean);
    if (!roles.some((x) => mine.includes(x))) throw new HttpError(403, 'That field is not available to your role');
  }

  const depts = (unj(def.allowed_department_ids, []) || []).map(Number).filter(Boolean);
  if (depts.length) {
    if (!req.user.employee_id) throw new HttpError(403, 'That field is not available to you');
    const [rows] = await pool.query(
      'SELECT department_id FROM employees WHERE id = ? AND tenant_id = ?', [req.user.employee_id, req.user.tenant_id]
    );
    if (!rows[0] || !depts.includes(Number(rows[0].department_id))) {
      throw new HttpError(403, 'That field is not available in your department');
    }
  }
}

// ------------------------------------------------------------- forms
/** GET /forms/:key — a form plus its sections, fields and bound definitions. */
r.get('/forms', FORM_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    `SELECT f.*, (SELECT COUNT(*) FROM custom_form_sections s WHERE s.form_id = f.id) AS section_count,
            (SELECT COUNT(*) FROM custom_form_fields ff WHERE ff.form_id = f.id) AS field_count
     FROM custom_forms f WHERE f.tenant_id = ? ORDER BY f.entity_type, f.name`, [t]
  );
  res.json({ data: decode(rows, []) });
}));

r.get('/forms/:id', FORM_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query('SELECT * FROM custom_forms WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Form not found');
  const form = decode(rows[0], []);
  const [sections] = await pool.query('SELECT * FROM custom_form_sections WHERE form_id = ? ORDER BY sort_order', [form.id]);
  const [fields] = await pool.query(
    `SELECT ff.*, cf.field_type AS definition_type, cf.entity_type AS definition_entity
     FROM custom_form_fields ff LEFT JOIN custom_field_definitions cf ON cf.id = ff.field_id
     WHERE ff.form_id = ? ORDER BY ff.sort_order`, [form.id]
  );
  res.json({
    data: {
      ...form,
      sections: sections.map((s) => ({
        ...decode(s, ['visibility']),
        fields: fields.filter((f) => f.section_id === s.id),
      })),
      unsectionedFields: fields.filter((f) => !f.section_id),
    },
  });
}));

r.post('/forms', FORM_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { form_key: formKey, name, entity_type: entityType, description, sections = [], fields = [] } = req.body || {};
  if (!formKey || !name) throw new HttpError(400, 'form_key and name are required');
  const key = String(formKey).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const [dupe] = await pool.query('SELECT id FROM custom_forms WHERE tenant_id = ? AND form_key = ?', [t, key]);
  if (dupe[0]) throw new HttpError(409, 'A form with that key already exists');
  const [ins] = await pool.query(
    `INSERT INTO custom_forms (tenant_id, form_key, name, entity_type, description, version, status, is_system, created_by)
     VALUES (?,?,?,?,?,1,'draft',0,?)`,
    [t, key, name, entityType || 'employee', description || null, req.user.id]
  );
  await saveFormContent(t, ins.insertId, sections, fields);
  await audit(req, { action: 'form.create', entityType: 'form', entityId: ins.insertId, after: { key, name } });
  res.status(201).json({ data: { id: ins.insertId, form_key: key } });
}));

r.put('/forms/:id', FORM_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM custom_forms WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Form not found');
  if (rows[0].is_system) throw new HttpError(403, 'System forms are read-only');
  const { name, description, status, sections, fields } = req.body || {};
  const sets = []; const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (status) {
    if (!['draft', 'published', 'archived'].includes(status)) throw new HttpError(400, 'status must be draft, published or archived');
    sets.push('status = ?'); params.push(status);
    if (status === 'published') sets.push('published_at = NOW()');
  }
  if (sets.length) {
    params.push(rows[0].id, t);
    await pool.query(`UPDATE custom_forms SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  }
  if (Array.isArray(sections) || Array.isArray(fields)) {
    await pool.query('DELETE FROM custom_form_fields WHERE form_id = ?', [rows[0].id]);
    await pool.query('DELETE FROM custom_form_sections WHERE form_id = ?', [rows[0].id]);
    await saveFormContent(t, rows[0].id, sections || [], fields || []);
  }
  await audit(req, { action: 'form.update', entityType: 'form', entityId: rows[0].id, before: decode(rows[0], []), after: { name, status } });
  res.json({ ok: true });
}));

async function saveFormContent(tenant, formId, sections = [], fields = []) {
  const sectionIds = new Map();
  for (const [i, s] of sections.entries()) {
    const [ins] = await pool.query(
      `INSERT INTO custom_form_sections (tenant_id, form_id, title, description, sort_order, visibility)
       VALUES (?,?,?,?,?,?)`,
      [tenant, formId, s.title || `Section ${i + 1}`, s.description || null, int(s.sort_order, i), j(s.visibility || 'all')]
    );
    sectionIds.set(s.key ?? s.title ?? i, ins.insertId);
  }
  const rows = [];
  for (const [i, f] of fields.entries()) {
    rows.push([
      tenant, formId,
      f.section_key !== undefined ? (sectionIds.get(f.section_key) ?? sectionIds.get(f.section_title) ?? null) : (f.section_id || null),
      int(f.field_id) || null,
      f.field_key || null, f.label || 'Untitled field', f.field_type || 'text',
      bool(f.required), f.default_value ?? null, f.placeholder ?? null,
      j(f.options || []), j(f.validation || {}), j(f.visibility || 'all'),
      bool(f.is_locked), int(f.sort_order, i),
    ]);
  }
  await insertRows('custom_form_fields',
    ['tenant_id', 'form_id', 'section_id', 'field_id', 'field_key', 'label', 'field_type',
      'required', 'default_value', 'placeholder', 'options', 'validation', 'visibility', 'is_locked', 'sort_order'],
    rows);
}

r.delete('/forms/:id', FORM_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM custom_forms WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Form not found');
  if (rows[0].is_system) throw new HttpError(403, 'System forms cannot be deleted');
  await pool.query('DELETE FROM custom_form_fields WHERE form_id = ?', [rows[0].id]);
  await pool.query('DELETE FROM custom_form_sections WHERE form_id = ?', [rows[0].id]);
  await pool.query('DELETE FROM custom_forms WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  await audit(req, { action: 'form.delete', entityType: 'form', entityId: rows[0].id, before: decode(rows[0], []) });
  res.json({ ok: true });
}));

module.exports = r;
