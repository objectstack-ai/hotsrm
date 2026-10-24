import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_audit' };
const columns = [
  { field: 'audit_no' },
  { field: 'supplier' },
  { field: 'audit_type' },
  { field: 'status' },
  { field: 'planned_date' },
  { field: 'audit_date' },
  { field: 'auditors' },
  { field: 'checklist_score' },
  { field: 'result' },
];

// 05 §2：年度审核计划按计划日期排在日历上，SQE 与质量经理据此安排审核组（FR-607，WI-01 6.9）
export const SupplierAuditViews = defineView({
  list: {
    label: '全部审核',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'audit_no', order: 'desc' }],
  },

  listViews: {
    planned: {
      label: '计划中',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'planned' }],
      sort: [{ field: 'planned_date', order: 'asc' }],
    },
    calendar: {
      label: '审核日历',
      type: 'calendar',
      data,
      columns: ['audit_no', 'supplier', 'audit_type', 'status'],
      filter: [{ field: 'status', operator: 'equals', value: 'planned' }],
      // 临时：标题本应显示供应商，但日历把 lookup 值当对象渲染成「[object Object]」（objectui#13471），先用审核编号
      calendar: { startDateField: 'planned_date', titleField: 'audit_no', colorField: 'audit_type' },
    },
    admission: {
      label: '准入审核',
      type: 'grid',
      data,
      columns: [...columns.filter((c) => c.field !== 'audit_type'), { field: 'application' }, { field: 'sample_result' }],
      filter: [{ field: 'audit_type', operator: 'equals', value: 'admission' }],
      sort: [{ field: 'audit_no', order: 'desc' }],
    },
  },
});
