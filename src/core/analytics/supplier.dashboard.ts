import type { Dashboard } from '@objectstack/spec/ui';

// 05 §4.2 供应商看板（v0.5 风险事件随附）：供应商按生命周期分布、资质异常与黑名单数、未关闭风险事件按严重度与类型。
// 看的是当前状况，不设日期区间。30 天内到期证书数、准入申请积压两张卡片后续补上。
export const SupplierDashboard: Dashboard = {
  name: 'srm_supplier_dashboard',
  label: '供应商',
  description: '供应商按生命周期分布、资质异常与黑名单数、未关闭风险事件按严重度与类型',
  columns: 12,
  widgets: [
    {
      id: 'suppliers_by_status',
      type: 'column',
      title: '供应商按生命周期分布',
      dataset: 'srm_supplier_metrics',
      dimensions: ['status'],
      values: ['supplier_count'],
      layout: { x: 0, y: 0, w: 8, h: 4 },
    },
    {
      id: 'qualification_alerts',
      type: 'metric',
      title: '资质异常供应商',
      dataset: 'srm_supplier_metrics',
      values: ['alert_count'],
      layout: { x: 8, y: 0, w: 4, h: 2 },
      colorVariant: 'danger',
    },
    {
      id: 'blacklisted_suppliers',
      type: 'metric',
      title: '黑名单供应商',
      dataset: 'srm_supplier_metrics',
      values: ['blacklisted_count'],
      layout: { x: 8, y: 2, w: 4, h: 2 },
    },
    {
      id: 'unclosed_risks_by_severity',
      type: 'column',
      title: '未关闭风险事件（按严重度）',
      dataset: 'srm_risk_event_metrics',
      dimensions: ['severity'],
      values: ['unclosed_count'],
      filter: { status: { $in: ['open', 'mitigating'] } },
      layout: { x: 0, y: 4, w: 6, h: 4 },
    },
    {
      id: 'unclosed_risks_by_type',
      type: 'horizontal-bar',
      title: '未关闭风险事件（按类型）',
      dataset: 'srm_risk_event_metrics',
      dimensions: ['risk_type'],
      values: ['unclosed_count'],
      filter: { status: { $in: ['open', 'mitigating'] } },
      layout: { x: 6, y: 4, w: 6, h: 4 },
    },
    {
      id: 'unclosed_high_risks',
      type: 'metric',
      title: '未关闭高风险事件',
      dataset: 'srm_risk_event_metrics',
      values: ['unclosed_high_count'],
      layout: { x: 0, y: 8, w: 4, h: 2 },
      colorVariant: 'danger',
    },
  ],
};
