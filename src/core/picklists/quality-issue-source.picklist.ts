import { definePicklist } from '@objectstack/spec/data';

// 整改单来源（02 §4.6）：扩展包可能追加来源（02 §1 第 13 条），所以做成共享选项列表
export const QualityIssueSourcePicklist = definePicklist({
  name: 'srm_quality_issue_source',
  label: '整改单来源',
  options: [
    { label: '来料', value: 'iqc' },
    { label: '制程', value: 'production' },
    { label: '客户投诉', value: 'customer' },
    { label: '审核发现', value: 'audit' },
    { label: '绩效改善', value: 'performance' },
  ],
});
