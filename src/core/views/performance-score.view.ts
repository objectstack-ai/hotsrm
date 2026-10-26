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

// 05 §2：「待我评分」列出指派给本人、还没评分的评分项，从这里点进考评单「提交评分」（03 §10 第 3 步）；
// 「回避改派」列出按 GL-06 6.4.5 改派过评分人的评分项，供内控和采购部统计回避情况
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
    reassigned: {
      label: '回避改派',
      type: 'grid',
      data,
      columns: [
        { field: 'review' },
        { field: 'kpi' },
        { field: 'reassigned_from' },
        { field: 'scorer' },
        { field: 'reassigned_by' },
        { field: 'reassigned_date' },
        { field: 'reassign_reason' },
        { field: 'scored' },
      ],
      filter: [{ field: 'reassigned_by', operator: 'is_not_null' }],
      sort: [{ field: 'reassigned_date', order: 'desc' as const }],
    },
  },
});
