import { ObjectSchema, Field } from '@objectstack/spec/data';

// 采购品类（02 §4.1）。mandatory_cert_types 依赖证书类型选项列表，随证书对象一起加。
export const Category = ObjectSchema.create({
  name: 'srm_category',
  label: '采购品类',
  pluralLabel: '采购品类',
  icon: 'folder-tree',
  sharingModel: 'public_read',

  fields: {
    code: Field.text({ label: '品类编码', required: true, unique: true, maxLength: 40 }),
    name: Field.text({ label: '品类名称', required: true, searchable: true, maxLength: 100 }),
    parent: { type: 'tree', label: '上级品类', reference: 'srm_category' },
    category_manager: Field.user({ label: '品类经理' }),
    sqe: Field.user({ label: 'SQE' }),
    is_direct: Field.boolean({ label: '直接物料', defaultValue: true }),
    risk_class: Field.select({
      label: '风险等级',
      required: true,
      defaultValue: 'medium',
      options: [
        { label: '高', value: 'high' },
        { label: '中', value: 'medium' },
        { label: '低', value: 'low' },
      ],
    }),
  },
});
