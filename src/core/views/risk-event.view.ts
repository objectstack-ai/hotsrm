import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_risk_event' };
const columns = [
  { field: 'event_no' },
  { field: 'supplier' },
  { field: 'risk_type' },
  { field: 'severity' },
  { field: 'source' },
  { field: 'status' },
  { field: 'disposition' },
  { field: 'created_at' },
];
const unclosed = { field: 'status', operator: 'in' as const, value: ['open', 'mitigating'] };

// 05 §1、§4.2：未关闭风险事件按严重度分列给品类经理、SQE 跟进；按类型看分布。供应商详情页的风险事件列表
// 来自事件的 supplier 关联（relatedListColumns）
export const RiskEventViews = defineView({
  list: {
    label: '全部风险事件',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'event_no', order: 'desc' }],
  },

  listViews: {
    board: {
      label: '风险看板',
      type: 'kanban',
      data,
      columns: ['event_no', 'supplier', 'risk_type', 'status', 'disposition'],
      filter: [unclosed],
      kanban: {
        groupByField: 'severity',
        columns: ['event_no', 'supplier', 'risk_type', 'status', 'disposition'],
      },
    },
    unclosed: {
      label: '未关闭风险事件',
      type: 'grid',
      data,
      columns,
      filter: [unclosed],
      sort: [{ field: 'created_at', order: 'asc' }],
    },
    by_type: {
      label: '按类型',
      type: 'kanban',
      data,
      columns: ['event_no', 'supplier', 'severity', 'status'],
      filter: [unclosed],
      kanban: {
        groupByField: 'risk_type',
        columns: ['event_no', 'supplier', 'severity', 'status'],
      },
    },
  },
});
