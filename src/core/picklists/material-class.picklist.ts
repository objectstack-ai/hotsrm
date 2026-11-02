import { definePicklist } from '@objectstack/spec/data';

// 物资 A / B / C 分类（P-D2，02 §4.1）：与体系文件的物资分类同源，决定准入审批是否会签质量经理、
// 审核频次和绩效周期（03 §12）。品类的 material_class 与准入申请的 material_class 共用
export const MaterialClassPicklist = definePicklist({
  name: 'srm_material_class',
  label: '物资类别',
  options: [
    { label: 'A 类（战略）', value: 'class_a' },
    { label: 'B 类（重要）', value: 'class_b' },
    { label: 'C 类（一般）', value: 'class_c' },
  ],
});
