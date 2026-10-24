import { defineDataset } from '@objectstack/spec/ui';

// 整改单统计（05 §4.2 质量看板）：未关闭整改单按状态分布、逾期整改单数；按期关闭率随 v0.5 绩效一起出
export const QualityIssueMetrics = defineDataset({
  name: 'srm_quality_issue_metrics',
  label: '整改单统计',
  description: '整改单按状态、供应商、严重度统计，含逾期数（整改单，05 §4.2）',
  object: 'srm_quality_issue',
  dimensions: [
    { name: 'status', label: '状态', field: 'status', type: 'string' },
    { name: 'supplier', label: '供应商', field: 'supplier', type: 'lookup' },
    { name: 'severity', label: '严重度', field: 'severity', type: 'string' },
    { name: 'source', label: '来源', field: 'source', type: 'string' },
    { name: 'created_month', label: '开单月份', field: 'created_at', type: 'date', dateGranularity: 'month' },
  ],
  measures: [
    { name: 'issue_count', label: '整改单数', aggregate: 'count' },
    {
      name: 'open_count',
      label: '未关闭整改单',
      aggregate: 'count',
      filter: { status: { $in: ['open', 'containment_submitted', 'action_submitted', 'verifying'] } },
    },
    {
      name: 'overdue_count',
      label: '逾期整改单',
      aggregate: 'count',
      filter: { is_overdue: true, status: { $in: ['open', 'containment_submitted', 'action_submitted', 'verifying'] } },
    },
  ],
});
