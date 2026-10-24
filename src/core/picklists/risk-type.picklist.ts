import { definePicklist } from '@objectstack/spec/data';

// 风险类型（02 §4.9）：扩展包可能追加类型（02 §1 第 13 条），所以做成共享选项列表
export const RiskTypePicklist = definePicklist({
  name: 'srm_risk_type',
  label: '风险类型',
  options: [
    { label: '资质', value: 'qualification' },
    { label: '司法诉讼', value: 'legal' },
    { label: '经营异常', value: 'operation' },
    { label: '财务', value: 'financial' },
    { label: '交付', value: 'delivery' },
    { label: '质量', value: 'quality' },
    { label: '环境社会治理', value: 'esg' },
    { label: '制裁名单', value: 'sanction' },
  ],
});
