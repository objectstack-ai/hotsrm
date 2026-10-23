import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商联系人（02 §4.1）。portal_user 随门户版本加入。
export const SupplierContact = ObjectSchema.create({
  name: 'srm_supplier_contact',
  label: '供应商联系人',
  pluralLabel: '供应商联系人',
  icon: 'contact',
  sharingModel: 'controlled_by_parent',

  fieldGroups: [
    { key: 'contact', label: '联系人信息', icon: 'contact' },
  ],

  fields: {
    supplier: Field.masterDetail('srm_supplier', { label: '供应商', required: true, deleteBehavior: 'cascade' }),
    name: Field.text({ label: '姓名', group: 'contact', required: true, searchable: true, maxLength: 50 }),
    contact_function: {
      type: 'multiselect',
      label: '职能',
      group: 'contact',
      options: [
        { label: '主账号', value: 'admin' },
        { label: '商务', value: 'sales' },
        { label: '物流', value: 'logistics' },
        { label: '质量', value: 'quality' },
        { label: '财务', value: 'finance' },
      ],
    },
    mobile: Field.phone({ label: '手机', group: 'contact' }),
    email: Field.email({ label: '邮箱', group: 'contact', required: true }),
    is_primary: Field.boolean({ label: '主联系人', group: 'contact', defaultValue: false }),
    active: Field.boolean({ label: '有效', group: 'contact', defaultValue: true }),
  },
});
