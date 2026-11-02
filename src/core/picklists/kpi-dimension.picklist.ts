import { definePicklist } from '@objectstack/spec/data';

// 绩效维度（02 §4.7，QP-01 6.7.2）：QCDS 加安全环保，考评单按维度存分项得分。
// 扩展包可能追加维度（02 §1 第 13 条），所以做成共享选项列表
export const KpiDimensionPicklist = definePicklist({
  name: 'srm_kpi_dimension',
  label: '绩效维度',
  options: [
    { label: '质量', value: 'quality' },
    { label: '成本', value: 'cost' },
    { label: '交付', value: 'delivery' },
    { label: '服务', value: 'service' },
    { label: '安全环保', value: 'hse' },
  ],
});
