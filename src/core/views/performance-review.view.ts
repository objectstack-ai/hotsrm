import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_performance_review' };
const columns = [
  { field: 'review_no' },
  { field: 'supplier' },
  { field: 'cycle' },
  { field: 'period' },
  { field: 'status' },
  { field: 'delivery_count' },
  { field: 'otd_rate' },
  { field: 'lot_pass_rate' },
  { field: 'ppm' },
  { field: 'data_incomplete' },
  { field: 'total_score' },
  { field: 'grade' },
];
const sort = [{ field: 'period', order: 'desc' as const }, { field: 'review_no', order: 'desc' as const }];

// 05 §2：考评单按期间倒序；「待评分」给采购总监跟进人工评分，「数据不全」提示本期交付数据没导入或不全（07 R7）
export const PerformanceReviewViews = defineView({
  list: {
    label: '全部考评单',
    type: 'grid',
    data,
    columns,
    sort,
  },

  listViews: {
    scoring: {
      label: '待评分',
      type: 'grid',
      data,
      columns: columns.filter((c) => c.field !== 'status' && c.field !== 'total_score' && c.field !== 'grade'),
      filter: [{ field: 'status', operator: 'equals', value: 'scoring' }],
      sort,
    },
    incomplete: {
      label: '数据不全',
      type: 'grid',
      data,
      columns: columns.filter((c) => c.field !== 'data_incomplete'),
      filter: [{ field: 'data_incomplete', operator: 'equals', value: true }],
      sort,
    },
  },
});
