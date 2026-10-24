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
  { field: 'submitted_by' },
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
    // flow 生成的草稿（高风险事件、绩效结果应用，v0.5）：品类经理核实后提交审批或作废
    draft: {
      label: '待提交草稿',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'draft' }],
    },
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
