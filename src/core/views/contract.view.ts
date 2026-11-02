import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_contract' };
const columns = [
  { field: 'contract_no' },
  { field: 'title' },
  { field: 'supplier' },
  { field: 'contract_type' },
  { field: 'status' },
  { field: 'start_date' },
  { field: 'end_date' },
  { field: 'amount' },
];

export const ContractViews = defineView({
  list: {
    label: '全部合同',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'contract_no', order: 'desc' }],
  },

  listViews: {
    // 生效中、60 天内到期（与到期提醒的最早一档一致，params/core.yaml contract_reminder_days）
    expiring: {
      label: '即将到期',
      type: 'grid',
      data,
      columns: [...columns, { field: 'auto_renew' }],
      filter: [
        { field: 'status', operator: 'equals', value: 'active' },
        { field: 'end_date', operator: 'greater_than_or_equal', value: '{today}' },
        { field: 'end_date', operator: 'less_than_or_equal', value: '{60_days_from_now}' },
      ],
      sort: [{ field: 'end_date', order: 'asc' }],
    },
    by_supplier: {
      label: '按供应商',
      type: 'grid',
      data,
      columns,
      grouping: { fields: [{ field: 'supplier', order: 'asc' }] },
      sort: [{ field: 'end_date', order: 'desc' }],
    },
  },
});
