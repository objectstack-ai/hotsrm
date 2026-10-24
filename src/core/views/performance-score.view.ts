import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_performance_score' };
const columns = [
  { field: 'review' },
  { field: 'kpi' },
  { field: 'weight' },
  { field: 'raw_value' },
  { field: 'score' },
  { field: 'scored' },
  { field: 'defaulted' },
  { field: 'scorer' },
  { field: 'comment' },
];
const sort = [{ field: 'review', order: 'desc' as const }];

// 05 §2：「待我评分」列出指派给本人、还没评分的评分项，从这里点进考评单「提交评分」（03 §10 第 3 步）
export const PerformanceScoreViews = defineView({
  list: {
    label: '全部评分项',
    type: 'grid',
    data,
    columns,
    sort,
  },

  listViews: {
    mine: {
      label: '待我评分',
      type: 'grid',
      data,
      columns: columns.filter((c) => c.field !== 'scorer' && c.field !== 'scored' && c.field !== 'defaulted'),
      filter: [
        { field: 'scorer', operator: 'equals', value: '{current_user_id}' },
        { field: 'scored', operator: 'equals', value: false },
      ],
      sort,
    },
  },
});
