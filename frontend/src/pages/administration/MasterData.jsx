import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { CheckField, Confirm, Empty, Modal, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

export default function AdminMasterData() {
  return (
    <AdminSection sectionKey="master-data">
      <MasterData />
    </AdminSection>
  );
}

function MasterData() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: cats, loading, reload } = useLoader(listLoader('/administration/master-data/categories'), []);
  const [active, setActive] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [form, setForm] = useState({});
  const canManage = can('administration.master_data.manage');

  // Default to the first category once the list arrives.
  const selected = (cats || []).find((c) => c.id === active) || (cats || [])[0] || null;

  const open = (row) => {
    setEditing(row || {});
    setForm(row || { code: '', name: '', description: '', system_key: '', is_active: 1 });
  };
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const payload = {
      code: form.code || null,
      name: form.name,
      description: form.description || null,
      system_key: form.system_key || null,
      is_active: form.is_active ? 1 : 0,
    };
    try {
      if (editing?.id) await api.put(`/administration/master-data/categories/${editing.id}`, payload);
      else await api.post('/administration/master-data/categories', payload);
      toast(editing?.id ? 'Category updated' : 'Category created');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/master-data/categories/${deleting.id}`);
      toast('Category deleted');
      setDeleting(null);
      setActive(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <PageHeader
        title="Master Data"
        sub="Company-defined lists — cost centres, shift patterns, expense heads — that other modules reference."
      />
      <div className="split">
        <aside className="split-side">
          <div className="spread mb">
            <b style={{ fontSize: 13 }}>Categories</b>
            {canManage && <button className="btn ghost sm" onClick={() => open(null)}>+ Add</button>}
          </div>
          {loading && !cats ? <Spinner /> : !cats?.length ? (
            <Empty icon="🗃️" text="No categories yet" />
          ) : cats.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'pane-item' + (selected?.id === c.id ? ' active' : '')}
              onClick={() => setActive(c.id)}
            >
              <span className="pane-item-text">
                <span className="pane-item-title">{c.name}</span>
                <span className="pane-item-sub">{c.code || `key: ${c.system_key || c.id}`}</span>
              </span>
              <span className="pane-item-count">{num(c.item_count)}</span>
            </button>
          ))}
        </aside>

        <div className="split-main">
          {selected ? <Items category={selected} canManage={canManage} /> : <Empty icon="👈" text="Pick a category" />}
        </div>
      </div>

      {editing !== null && (
        <Modal
          title={editing.id ? `Edit “${editing.name}”` : 'Add category'}
          onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save} disabled={!form.name}>Save</button></>}
        >
          <div className="form-grid">
            <TextField label="Name" value={form.name} onChange={setF('name')} />
            <TextField label="Code" value={form.code} onChange={setF('code')} />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Description" value={form.description} onChange={setF('description')} />
            </div>
            {!editing.id && <TextField label="System key" value={form.system_key} onChange={setF('system_key')} hint="optional stable identifier" />}
            <CheckField label="Active" checked={Number(form.is_active) === 1} onChange={setF('is_active')} />
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm
          title="Delete category?"
          message={`“${deleting.name}” and its ${deleting.item_count ?? 0} item(s) will be removed. Records that referenced them keep their text.`}
          danger
          onYes={doDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function Items({ category, canManage }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(
    listLoader(`/administration/master-data/items?category_id=${category.id}`),
    [category.id]
  );
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const open = (row) => {
    setEditing(row || {});
    setForm(row || { code: '', name: '', description: '', sort_order: 0, status: 'active' });
  };

  const save = async () => {
    const payload = {
      name: form.name,
      description: form.description || null,
      sort_order: Number(form.sort_order || 0),
      status: form.status || 'active',
    };
    try {
      if (editing?.id) await api.put(`/administration/master-data/items/${editing.id}`, payload);
      else await api.post('/administration/master-data/items', { ...payload, category_id: category.id, code: form.code || null });
      toast(editing?.id ? 'Item updated' : 'Item added');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/master-data/items/${deleting.id}`);
      toast('Item deleted');
      setDeleting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <div className="spread mb">
        <b style={{ fontSize: 14 }}>{category.name}</b>
        {canManage && <button className="btn sm" onClick={() => open(null)}>+ Add item</button>}
      </div>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'name', label: 'Item' },
          { key: 'code', label: 'Code', render: (r) => (r.code ? <code style={{ fontSize: 12 }}>{r.code}</code> : '—') },
          { key: 'description', label: 'Description' },
          { key: 'sort_order', label: 'Order', align: 'right' },
          { key: 'effective_from', label: 'From', render: (r) => (r.effective_from ? r.effective_from : '—') },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (canManage ? (
          <>
            <button className="btn ghost sm" onClick={() => open(row)}>Edit</button>
            <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
          </>
        ) : null)}
      />

      {editing !== null && (
        <Modal
          title={editing.id ? `Edit “${editing.name}”` : `Add item to ${category.name}`}
          onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save} disabled={!form.name}>Save</button></>}
        >
          <div className="form-grid">
            <TextField label="Name" value={form.name} onChange={setF('name')} />
            {!editing.id && <TextField label="Code" value={form.code} onChange={setF('code')} />}
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Description" value={form.description} onChange={setF('description')} />
            </div>
            <TextField label="Sort order" type="number" value={form.sort_order} onChange={setF('sort_order')} />
            <TextField label="Status" value={form.status} onChange={setF('status')} hint="active or inactive" />
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm title="Delete item?" message={`“${deleting.name}” will be removed from ${category.name}.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}