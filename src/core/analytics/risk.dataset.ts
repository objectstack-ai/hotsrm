import { defineDataset } from '@objectstack/spec/ui';

// 风险事件统计（05 §4.2 供应商看板）：未关闭风险事件按严重度、类型分布
export const RiskEventMetrics = defineDataset({
  name: 'srm_risk_event_metrics',
  label: '风险事件统计',
  description: '风险事件按严重度、类型、来源、供应商统计，含未关闭数（风险事件，05 §4.2）',
  object: 'srm_risk_event',
  dimensions: [
    { name: 'severity', label: '严重度', field: 'severity', type: 'string' },
    { name: 'risk_type', label: '风险类型', field: 'risk_type', type: 'string' },
    { name: 'source', label: '来源', field: 'source', type: 'string' },
    { name: 'status', label: '状态', field: 'status', type: 'string' },
    { name: 'supplier', label: '供应商', field: 'supplier', type: 'lookup' },
    { name: 'created_month', label: '登记月份', field: 'created_at', type: 'date', dateGranularity: 'month' },
  ],
  measures: [
    { name: 'event_count', label: '风险事件数', aggregate: 'count' },
    { name: 'unclosed_count', label: '未关闭风险事件', aggregate: 'count', filter: { status: { $in: ['open', 'mitigating'] } } },
    {
      name: 'unclosed_high_count',
      label: '未关闭高风险事件',
      aggregate: 'count',
      filter: { severity: 'high', status: { $in: ['open', 'mitigating'] } },
    },
  ],
});

// 供应商统计（05 §4.2 供应商看板）：按生命周期分布、资质异常数、黑名单数
export const SupplierMetrics = defineDataset({
  name: 'srm_supplier_metrics',
  label: '供应商统计',
  description: '供应商按生命周期状态、类型统计，含资质异常数与黑名单数（供应商，05 §4.2）',
  object: 'srm_supplier',
  dimensions: [
    { name: 'status', label: '状态', field: 'status', type: 'string' },
    { name: 'supplier_type', label: '供应商类型', field: 'supplier_type', type: 'string' },
  ],
  measures: [
    { name: 'supplier_count', label: '供应商数', aggregate: 'count' },
    { name: 'alert_count', label: '资质异常供应商', aggregate: 'count', filter: { qualification_alert: true } },
    { name: 'blacklisted_count', label: '黑名单供应商', aggregate: 'count', filter: { status: 'blacklisted' } },
  ],
});
