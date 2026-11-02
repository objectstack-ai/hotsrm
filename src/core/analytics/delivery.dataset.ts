import { defineDataset } from '@objectstack/spec/ui';

// 交付与质量指标（05 §4.1）。每条交付记录一行，比率用两个计数或合计之比（derived ratio）表达：
// OTD = 准时行 ÷ 交付行；批次合格率 = 合格行 ÷ 已检行（让步接收计不合格）；PPM = Σ不良数 ÷ Σ实收数（百万）。
// 只用存储字段（on_time、inspection_result、defect_quantity、received_quantity_mn），不在查询时算单行的值。
export const DeliveryMetrics = defineDataset({
  name: 'srm_delivery_metrics',
  label: '交付与质量指标',
  description: '按供应商、期间统计交付行数、准时行数、批次合格与 PPM（交付记录，05 §4.1）',
  object: 'srm_delivery_record',
  include: ['material'],
  dimensions: [
    { name: 'supplier', label: '供应商', field: 'supplier', type: 'lookup' },
    { name: 'period', label: '期间', field: 'period', type: 'string' },
    { name: 'receipt_month', label: '实到月份', field: 'receipt_date', type: 'date', dateGranularity: 'month' },
    { name: 'plant', label: '工厂', field: 'plant', type: 'lookup' },
    { name: 'material', label: '物料', field: 'material', type: 'lookup' },
    { name: 'category', label: '采购品类', field: 'material.category', type: 'lookup' },
    { name: 'inspection_result', label: '检验结论', field: 'inspection_result', type: 'string' },
    { name: 'severity', label: '严重度', field: 'severity', type: 'string' },
  ],
  measures: [
    { name: 'line_count', label: '交付行数', aggregate: 'count' },
    { name: 'on_time_count', label: '准时行数', aggregate: 'count', filter: { on_time: true } },
    { name: 'late_count', label: '不准时行数', aggregate: 'count', filter: { on_time: false } },
    { name: 'otd_rate', label: '交付准时率', derived: { op: 'ratio', of: ['on_time_count', 'line_count'] }, format: '0.0%' },
    { name: 'inspected_count', label: '已检行数', aggregate: 'count', filter: { inspection_result: { $in: ['pass', 'fail', 'concession'] } } },
    { name: 'passed_count', label: '合格行数', aggregate: 'count', filter: { inspection_result: 'pass' } },
    { name: 'nonconforming_count', label: '不合格行数', aggregate: 'count', filter: { inspection_result: { $in: ['fail', 'concession'] } } },
    { name: 'lot_pass_rate', label: '批次合格率', derived: { op: 'ratio', of: ['passed_count', 'inspected_count'] }, format: '0.0%' },
    { name: 'received_sum', label: '实收数量', aggregate: 'sum', field: 'received_quantity', format: '0,0' },
    { name: 'defect_sum', label: '不良数', aggregate: 'sum', field: 'defect_quantity', format: '0,0' },
    { name: 'received_mn_sum', label: '实收数量（百万）', aggregate: 'sum', field: 'received_quantity_mn', format: '0,0.000000' },
    { name: 'ppm', label: 'PPM', derived: { op: 'ratio', of: ['defect_sum', 'received_mn_sum'] }, format: '0,0' },
    { name: 'amount_sum', label: '交付金额', aggregate: 'sum', field: 'amount', currency: 'CNY' },
  ],
});
