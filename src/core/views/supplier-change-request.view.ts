import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_change_request' };
const columns = [
  { field: 'change_no' },
  { field: 'supplier' },
  { field: 'change_type' },
  { field: 'status' },
  { field: 'approval_status' },
  { field: 'created_by' },
  { field: 'applied_at' },
];

export const SupplierChangeRequestViews = defineView({
  list: {
    label: '全部变更单',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'change_no', order: 'desc' }],
  },

  listViews: {
    in_review: {
      label: '审批中',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'in_review' }],
    },
    // 被退回、等发起人修改后重新提交的变更单
    returned: {
      label: '退回修改',
      type: 'grid',
      data,
      columns,
      filter: [
        { field: 'status', operator: 'equals', value: 'in_review' },
        { field: 'approval_status', operator: 'equals', value: 'returned' },
      ],
    },
  },
});
