import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_application' };
const columns = [
  { field: 'application_no' },
  { field: 'supplier' },
  { field: 'applied_categories' },
  { field: 'status' },
  { field: 'reviewer' },
  { field: 'approval_status' },
];

export const SupplierApplicationViews = defineView({
  list: {
    label: '全部准入申请',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'application_no', order: 'desc' }],
  },

  listViews: {
    in_progress: {
      label: '进行中',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'in', value: ['submitted', 'doc_review', 'returned', 'admission_review'] }],
    },
  },
});
