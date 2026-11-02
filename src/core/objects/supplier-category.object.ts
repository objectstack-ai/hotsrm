import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供货品类资格（02 §4.1）：同一供应商同一品类一条。source_application 随准入申请对象加入。
// 资格状态与冻结记录只由 flow 写入（准入审批、处置执行）。
export const SupplierCategory = ObjectSchema.create({
  name: 'srm_supplier_category',
  label: '供货品类资格',
  pluralLabel: '供货品类资格',
  icon: 'tags',
  nameField: 'category',
  sharingModel: 'controlled_by_parent',

  fieldGroups: [
    { key: 'qualification', label: '品类资格', icon: 'tags' },
  ],

  fields: {
    supplier: Field.masterDetail('srm_supplier', { label: '供应商', required: true, deleteBehavior: 'cascade' }),
    category: Field.lookup('srm_category', { label: '品类', group: 'qualification', required: true }),
    status: Field.select({
      label: '资格状态',
      group: 'qualification',
      required: true,
      defaultValue: 'trial',
      options: [
        { label: '试供', value: 'trial' },
        { label: '合格', value: 'qualified' },
        { label: '暂停', value: 'suspended' },
      ],
    }),
    approved_date: Field.date({ label: '批准日期', group: 'qualification' }),
    // 处置单冻结时记下暂停前的状态和冻结范围，解冻只恢复同一范围冻结的资格，原本就暂停的不动
    // （srm_disposition_apply 写入，v0.3）
    status_before_freeze: Field.select({
      label: '冻结前状态',
      group: 'qualification',
      readonly: true,
      options: [
        { label: '试供', value: 'trial' },
        { label: '合格', value: 'qualified' },
      ],
    }),
    freeze_scope: Field.select({
      label: '冻结范围',
      group: 'qualification',
      readonly: true,
      options: [
        { label: '全部品类', value: 'all' },
        { label: '指定品类', value: 'category' },
      ],
    }),
    freeze_disposition: Field.lookup('srm_supplier_disposition', { label: '冻结处置单', group: 'qualification', readonly: true }),
  },

  indexes: [
    { name: 'srm_supplier_category_unique', fields: ['supplier', 'category'], unique: 'organization' },
  ],
});
