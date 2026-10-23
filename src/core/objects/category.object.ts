import { ObjectSchema, Field } from '@objectstack/spec/data';

// 采购品类（02 §4.1）。
export const Category = ObjectSchema.create({
  name: 'srm_category',
  label: '采购品类',
  pluralLabel: '采购品类',
  icon: 'folder-tree',
  sharingModel: 'public_read',

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'folder-tree' },
    { key: 'admission', label: '准入要求', icon: 'shield-check' },
  ],

  fields: {
    code: Field.text({ label: '品类编码', group: 'basic', required: true, unique: true, maxLength: 40 }),
    name: Field.text({ label: '品类名称', group: 'basic', required: true, searchable: true, maxLength: 100 }),
    parent: { type: 'tree', label: '上级品类', group: 'basic', reference: 'srm_category' },
    category_manager: Field.user({ label: '品类经理', group: 'basic' }),
    sqe: Field.user({ label: 'SQE', group: 'basic' }),
    is_direct: Field.boolean({ label: '直接物料', group: 'basic', defaultValue: true }),
    risk_class: Field.select({
      label: '风险等级',
      group: 'admission',
      required: true,
      defaultValue: 'medium',
      options: [
        { label: '高', value: 'high' },
        { label: '中', value: 'medium' },
        { label: '低', value: 'low' },
      ],
    }),
    mandatory_cert_types: { type: 'multiselect', label: '必备资质类型', group: 'admission', picklist: 'srm_cert_type' },
  },
});
