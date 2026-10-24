import type { Dashboard } from '@objectstack/spec/ui';

// 05 §4.2 交付、质量两块看板里只依赖交付记录的卡片（v0.4）。按供应商的 OTD 趋势、逾期整改单等随考评单、
// 整改单上线再加。数据按月导入上月的收货，所以默认看上月；平台的数据集图表不能指定堆叠，
// 「准时 / 不准时」画成按月并列的两组柱。
const lastMonth = { field: 'receipt_date', defaultRange: 'last_month' as const, allowCustomRange: true };

export const DeliveryDashboard: Dashboard = {
  name: 'srm_delivery_dashboard',
  label: '交付',
  description: '按月准时 / 不准时交付行数，按供应商的交付准时率',
  columns: 12,
  widgets: [
    {
      id: 'on_time_by_month',
      type: 'column',
      title: '按月准时 / 不准时交付行数',
      dataset: 'srm_delivery_metrics',
      dimensions: ['receipt_month'],
      values: ['on_time_count', 'late_count'],
      filter: { receipt_date: { $gte: '{12_months_ago}' } },
      layout: { x: 0, y: 0, w: 12, h: 4 },
    },
    {
      id: 'otd_by_supplier',
      type: 'table',
      title: '上月按供应商的交付准时率',
      dataset: 'srm_delivery_metrics',
      dimensions: ['supplier'],
      values: ['line_count', 'on_time_count', 'otd_rate'],
      filter: { receipt_date: { $gte: '{last_month_start}', $lte: '{last_month_end}' } },
      options: { sortBy: 'otd_rate', sortOrder: 'asc' },
      layout: { x: 0, y: 4, w: 12, h: 5 },
    },
  ],
};

export const QualityDashboard: Dashboard = {
  name: 'srm_quality_dashboard',
  label: '质量',
  description: '不合格交付行、批次合格率与按供应商的 PPM 排名',
  columns: 12,
  dateRange: lastMonth,
  widgets: [
    {
      id: 'nonconforming_lines',
      type: 'metric',
      title: '不合格交付行',
      dataset: 'srm_delivery_metrics',
      values: ['nonconforming_count'],
      layout: { x: 0, y: 0, w: 4, h: 2 },
      colorVariant: 'danger',
    },
    {
      id: 'lot_pass_rate',
      type: 'metric',
      title: '批次合格率',
      dataset: 'srm_delivery_metrics',
      values: ['lot_pass_rate'],
      layout: { x: 4, y: 0, w: 4, h: 2 },
    },
    {
      id: 'ppm_total',
      type: 'metric',
      title: 'PPM',
      dataset: 'srm_delivery_metrics',
      values: ['ppm'],
      layout: { x: 8, y: 0, w: 4, h: 2 },
    },
    {
      id: 'ppm_by_supplier',
      type: 'horizontal-bar',
      title: '按供应商的 PPM 排名',
      dataset: 'srm_delivery_metrics',
      dimensions: ['supplier'],
      values: ['ppm'],
      options: { sortBy: 'ppm', sortOrder: 'desc', limit: 10 },
      layout: { x: 0, y: 2, w: 6, h: 5 },
    },
    {
      id: 'nonconforming_by_supplier',
      type: 'table',
      title: '不合格交付（按供应商、物料）',
      dataset: 'srm_delivery_metrics',
      dimensions: ['supplier', 'material', 'inspection_result'],
      values: ['nonconforming_count', 'defect_sum'],
      filter: { inspection_result: { $in: ['fail', 'concession'] } },
      layout: { x: 6, y: 2, w: 6, h: 5 },
    },
  ],
};
