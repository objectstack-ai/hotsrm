import { P, F } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 合同明细（02 §4.4）。金额 = 数量 × 单价，由平台按表达式计算后存储，合同上的 line_amount 汇总它。
// 明细跟随合同（controlled_by_parent），只在合同为草稿或被退回修改时可增改（字段谓词读不到父记录，用 script 规则读一跳）。
export const ContractLine = ObjectSchema.create({
  name: 'srm_contract_line',
  label: '合同明细',
  pluralLabel: '合同明细',
  icon: 'list',
  nameField: 'description',
  sharingModel: 'controlled_by_parent',

  fieldGroups: [{ key: 'line', label: '明细', icon: 'list' }],

  fields: {
    contract: Field.masterDetail('srm_contract', {
      label: '合同',
      required: true,
      deleteBehavior: 'cascade',
      inlineEdit: true,
      relatedListColumns: ['line_no', 'material', 'description', 'quantity', 'uom', 'unit_price', 'tax_rate', 'amount'],
    }),
    line_no: Field.number({ label: '行号', group: 'line', required: true, scale: 0, min: 1 }),
    material: Field.lookup('srm_material', { label: '物料', group: 'line' }),
    description: Field.text({ label: '描述', group: 'line', required: true, maxLength: 200 }),
    quantity: Field.number({ label: '数量', group: 'line', min: 0 }),
    uom: Field.text({ label: '单位', group: 'line', maxLength: 20 }),
    unit_price: Field.currency({ label: '单价', group: 'line', min: 0 }),
    tax_rate: Field.percent({ label: '税率', group: 'line', min: 0, max: 1, scale: 2 }),
    amount: Field.currency({
      label: '金额',
      group: 'line',
      readonly: true,
      expression: F`(has(record.quantity) && record.quantity != null ? double(record.quantity) : 0.0) * (has(record.unit_price) && record.unit_price != null ? double(record.unit_price) : 0.0)`,
    }),
    valid_from: Field.date({ label: '有效期自', group: 'line' }),
    valid_to: Field.date({ label: '有效期至', group: 'line' }),
  },

  validations: [
    {
      name: 'line_valid_to_after_valid_from',
      type: 'script',
      severity: 'error',
      message: '有效期至不能早于有效期自',
      condition: P`has(record.valid_from) && has(record.valid_to) && record.valid_from != null && record.valid_to != null && record.valid_to < record.valid_from`,
    },
    {
      name: 'line_contract_draft',
      type: 'script',
      severity: 'error',
      message: '只有草稿或退回修改中的合同可以修改明细',
      condition: P`has(record.contract.status) && record.contract.status != 'draft' && (!has(record.contract.approval_status) || record.contract.approval_status != 'returned')`,
    },
  ],
});
