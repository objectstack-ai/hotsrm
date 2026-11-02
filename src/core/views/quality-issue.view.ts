import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_quality_issue' };
const columns = [
  { field: 'issue_no' },
  { field: 'supplier' },
  { field: 'material' },
  { field: 'source' },
  { field: 'severity' },
  { field: 'status' },
  { field: 'sqe' },
  { field: 'containment_due' },
  { field: 'final_due' },
  { field: 'is_overdue' },
  { field: 'claim_status' },
];
const unfinished = { field: 'status', operator: 'in' as const, value: ['open', 'containment_submitted', 'action_submitted', 'verifying'] };

// 05 §2：整改看板按状态分列给 SQE 跟进；逾期整改单给 SQE 与质量经理催办（FR-605）
export const QualityIssueViews = defineView({
  list: {
    label: '全部整改单',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'issue_no', order: 'desc' }],
  },

  listViews: {
    board: {
      label: '整改看板',
      type: 'kanban',
      data,
      columns: ['issue_no', 'supplier', 'severity', 'final_due', 'is_overdue'],
      filter: [{ field: 'status', operator: 'in', value: ['open', 'containment_submitted', 'action_submitted', 'verifying'] }],
      kanban: {
        groupByField: 'status',
        columns: ['issue_no', 'supplier', 'severity', 'final_due', 'is_overdue'],
      },
    },
    unfinished: {
      label: '未关闭整改单',
      type: 'grid',
      data,
      columns,
      filter: [unfinished],
      sort: [{ field: 'final_due', order: 'asc' }],
    },
    overdue: {
      label: '逾期整改单',
      type: 'grid',
      data,
      columns,
      filter: [unfinished, { field: 'is_overdue', operator: 'equals', value: true }],
      sort: [{ field: 'final_due', order: 'asc' }],
    },
    // 索赔结论：应付会计按「供应商已接受」的索赔在 ERP 扣款后标记已扣款（03 §8 第 6 步）
    claims: {
      label: '索赔',
      type: 'grid',
      data,
      columns: [{ field: 'issue_no' }, { field: 'supplier' }, { field: 'claim_amount' }, { field: 'claim_status' }, { field: 'status' }, { field: 'sqe' }],
      filter: [{ field: 'claim_status', operator: 'in', value: ['proposed', 'supplier_accepted', 'disputed', 'settled'] }],
    },
  },
});
