import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_delivery_record' };
const columns = [
  { field: 'erp_receipt_no' },
  { field: 'erp_order_no' },
  { field: 'erp_line_no' },
  { field: 'supplier' },
  { field: 'material' },
  { field: 'plant' },
  { field: 'required_date' },
  { field: 'promised_date' },
  { field: 'receipt_date' },
  { field: 'on_time' },
  { field: 'received_quantity' },
  { field: 'inspection_result' },
  { field: 'defect_quantity' },
  { field: 'period' },
];

// 05 §2：按月导入的交付记录按供应商 / 期间看；不合格、不准时两张工作列表给 SQE 和采购员
export const DeliveryRecordViews = defineView({
  list: {
    label: '全部交付记录',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'receipt_date', order: 'desc' }],
  },

  listViews: {
    by_period: {
      label: '按期间',
      type: 'grid',
      data,
      columns,
      grouping: { fields: [{ field: 'period', order: 'desc' }, { field: 'supplier', order: 'asc' }] },
      sort: [{ field: 'receipt_date', order: 'desc' }],
    },
    by_supplier: {
      label: '按供应商',
      type: 'grid',
      data,
      columns,
      grouping: { fields: [{ field: 'supplier', order: 'asc' }] },
      sort: [{ field: 'receipt_date', order: 'desc' }],
    },
    // 不合格与让步接收（批次合格率都计为不合格），按供应商分组；严重 / 主要不合格在 v0.4 Q2 自动开整改单
    nonconforming: {
      label: '不合格交付',
      type: 'grid',
      data,
      columns: [...columns.filter((c) => c.field !== 'on_time' && c.field !== 'promised_date'), { field: 'severity' }, { field: 'defect_description' }],
      filter: [{ field: 'inspection_result', operator: 'in', value: ['fail', 'concession'] }],
      grouping: { fields: [{ field: 'supplier', order: 'asc' }] },
      sort: [{ field: 'receipt_date', order: 'desc' }],
    },
    late: {
      label: '不准时交付',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'on_time', operator: 'equals', value: false }],
      grouping: { fields: [{ field: 'supplier', order: 'asc' }] },
      sort: [{ field: 'receipt_date', order: 'desc' }],
    },
  },
});
