import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_contact' };

// 门户账号季度复核（04 §3.3 回收）：列出已登记门户账号的联系人，采购主管对照组织成员页的外部成员确认差异
// （停用、离职、处置收回的联系人上已清掉 portal_user，不在此列）
export const SupplierContactViews = defineView({
  list: {
    label: '全部联系人',
    type: 'grid',
    data,
    columns: [{ field: 'supplier' }, { field: 'name' }, { field: 'contact_function' }, { field: 'email' }, { field: 'active' }],
    sort: [{ field: 'supplier', order: 'asc' }],
  },

  listViews: {
    portal_accounts: {
      label: '门户账号',
      type: 'grid',
      data,
      columns: [{ field: 'supplier' }, { field: 'name' }, { field: 'contact_function' }, { field: 'email' }, { field: 'portal_user' }, { field: 'active' }],
      sort: [{ field: 'supplier', order: 'asc' }],
      filter: [{ field: 'portal_user', operator: 'is_not_null' }],
    },
  },
});
