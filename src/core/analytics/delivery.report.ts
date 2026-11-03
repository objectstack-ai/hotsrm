import { defineReport } from '@objectstack/spec/ui';

// 按供应商、期间出 OTD、批次合格率、PPM（05 §4.1；v0.4 出口条件）。考评单（v0.5）按同一口径取数。
// 标签、说明的英文在翻译包的 reports 组（18.3.0 起报表可翻译，objectstack#25788）。
export const DeliveryScorecardReport = defineReport({
  name: 'srm_delivery_scorecard',
  label: '供应商交付与质量（按期间）',
  description: '每家供应商每个期间的交付行数、准时率、批次合格率与 PPM',
  type: 'summary',
  dataset: 'srm_delivery_metrics',
  rows: ['period', 'supplier'],
  values: ['line_count', 'on_time_count', 'otd_rate', 'inspected_count', 'passed_count', 'lot_pass_rate', 'received_sum', 'defect_sum', 'ppm'],
  order: [{ by: 'period', direction: 'desc' }, { by: 'supplier', direction: 'asc' }],
});
