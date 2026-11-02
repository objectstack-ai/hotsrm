import { ObjectSchema, Field } from '@objectstack/spec/data';

// 物料（02 §4.1）：ERP 物料主数据的只读副本，用平台导入按 erp_material_no 幂等写入（ADR-0008）。
// SRM 内只维护与品类的关联；其余字段对采购员只读，见权限集 srm_buyer。
export const Material = ObjectSchema.create({
  name: 'srm_material',
  label: '物料',
  pluralLabel: '物料',
  icon: 'package',
  // 采购员「可改不可删」靠按岗位授 edit 的共享规则 srm_material_edit_*（objectstack#25470 的裁定写法，02 §4.1）
  sharingModel: 'public_read',

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'package' },
    { key: 'external', label: '外部系统', icon: 'link' },
  ],

  fields: {
    material_code: Field.text({ label: '物料编码', group: 'basic', required: true, searchable: true, maxLength: 60 }),
    name: Field.text({ label: '物料名称', group: 'basic', required: true, searchable: true, maxLength: 200 }),
    specification: Field.text({ label: '规格型号', group: 'basic', searchable: true, maxLength: 500 }),
    uom: Field.text({ label: '计量单位', group: 'basic', maxLength: 20 }),
    category: Field.lookup('srm_category', { label: '采购品类', group: 'basic' }),
    active: Field.boolean({ label: '启用', group: 'basic', defaultValue: true }),
    erp_material_no: Field.text({ label: 'ERP 物料号', group: 'external', required: true, unique: true, maxLength: 60 }),
  },
});
