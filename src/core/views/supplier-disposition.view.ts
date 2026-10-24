import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_disposition' };
const columns = [
  { field: 'disposition_no' },
  { field: 'supplier' },
  { field: 'action' },
  { field: 'scope' },
  { field: 'status' },
  { field: 'approval_status' },
  { field: 'effective_date' },
  { field: 'created_by' },
  { field: 'applied_at' },
];

export const SupplierDispositionViews = defineView({
  list: {
    label: '全部处置单',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'disposition_no', order: 'desc' }],
  },

  listViews: {
    in_review: {
      label: '审批中',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'in_review' }],
    },
    // 采购员按这里的记录在 ERP 同步供应商冻结标志（ERP 集成前手工维护，06 I7）
    applied: {
      label: '已执行',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'applied' }],
      sort: [{ field: 'applied_at', order: 'desc' }],
    },
  },
});
