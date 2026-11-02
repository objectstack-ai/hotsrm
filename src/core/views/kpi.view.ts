import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_kpi' };
const columns = [
  { field: 'code' },
  { field: 'name' },
  { field: 'dimension' },
  { field: 'method' },
  { field: 'auto_metric' },
  { field: 'weight' },
  { field: 'active' },
  { field: 'scoring_rule' },
];
const sort = [{ field: 'dimension', order: 'asc' as const }, { field: 'code', order: 'asc' as const }];

// 02 §4.7：「启用指标」按维度分组，权重列的合计即方案总权重（应为 100%），分组表头是各维度小计
export const KpiViews = defineView({
  list: {
    label: '全部指标',
    type: 'grid',
    data,
    columns,
    sort,
  },

  listViews: {
    active: {
      label: '启用指标',
      type: 'grid',
      data,
      columns: columns.map((c) => (c.field === 'weight' ? { ...c, summary: 'sum' as const } : c)).filter((c) => c.field !== 'active'),
      filter: [{ field: 'active', operator: 'equals', value: true }],
      grouping: { fields: [{ field: 'dimension', order: 'asc' }] },
      sort,
    },
    inactive: {
      label: '已停用',
      type: 'grid',
      data,
      columns: columns.filter((c) => c.field !== 'active'),
      filter: [{ field: 'active', operator: 'equals', value: false }],
      sort,
    },
  },
});
