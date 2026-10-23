import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier' };

export const SupplierViews = defineView({
  list: {
    label: '全部供应商',
    type: 'grid',
    data,
    columns: [
      { field: 'supplier_no' },
      { field: 'name' },
      { field: 'country' },
      { field: 'supplier_type' },
      { field: 'status' },
      { field: 'qualification_alert' },
      { field: 'risk_level' },
    ],
    sort: [{ field: 'supplier_no', order: 'desc' }],
  },

  listViews: {
    qualification_alert: {
      label: '资质异常',
      type: 'grid',
      data,
      columns: [{ field: 'supplier_no' }, { field: 'name' }, { field: 'status' }, { field: 'expired_certificate_count' }],
      filter: [{ field: 'qualification_alert', operator: 'equals', value: true }],
    },
  },
});
