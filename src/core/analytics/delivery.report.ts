import { defineReport } from '@objectstack/spec/ui';

// 按供应商、期间出 OTD、批次合格率、PPM（05 §4.1；v0.4 出口条件）。考评单（v0.5）按同一口径取数。
// 报表在翻译包里没有词条组，标签用内联的多语言写法（ADR-0007）。
export const DeliveryScorecardReport = defineReport({
  name: 'srm_delivery_scorecard',
  label: { 'zh-CN': '供应商交付与质量（按期间）', en: 'Supplier Delivery and Quality by Period' },
  description: {
    'zh-CN': '每家供应商每个期间的交付行数、准时率、批次合格率与 PPM',
    en: 'Delivery lines, on-time rate, lot acceptance rate and PPM per supplier and period',
  },
  type: 'summary',
  dataset: 'srm_delivery_metrics',
  rows: ['period', 'supplier'],
  values: ['line_count', 'on_time_count', 'otd_rate', 'inspected_count', 'passed_count', 'lot_pass_rate', 'received_sum', 'defect_sum', 'ppm'],
  order: [{ by: 'period', direction: 'desc' }, { by: 'supplier', direction: 'asc' }],
});
