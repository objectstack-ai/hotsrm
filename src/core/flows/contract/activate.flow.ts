import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 确认签署生效（03 §6 第 3–4 步）：签署中的合同上传双方盖章件、填写签署日期后，由采购员、采购主管或
// 品类经理确认，合同置为「生效」。签署期间供应商被冻结、淘汰的，不能生效。质量协议、廉洁协议生效后
// 供应商标志由 srm_contract_agreement_recalc 置为 true。以系统身份运行，检查同 srm_contract_submit（objectstack#25481）。
const allowed =
  `current_user != null && ('srm_buyer' in current_user.positions || 'srm_buyer_lead' in current_user.positions`
  + ` || 'srm_category_manager' in current_user.positions)`;
const signing = `contract != null && contract.status == 'signing'`;
const filled = (k: string) => `has(contract.${k}) && contract.${k} != null && !isBlank(contract.${k})`;
const signed = `${filled('signed_file')} && ${filled('signed_date')}`;
const qualified = `supplier != null && supplier.status == 'qualified'`;

export const ContractActivateFlow: Automation.Flow = {
  name: 'srm_contract_activate',
  label: '确认签署生效',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '合同已生效',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取合同',
      config: { objectName: 'srm_contract', filter: { id: cel`recordId` }, outputVariable: 'contract' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`contract != null ? contract.supplier : ''` }, outputVariable: 'supplier' },
    },
    { id: 'gate', type: 'decision', label: '可以生效？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '没有权限',
      config: { outcome: 'refused', message: '只有采购员、采购主管或品类经理可以确认合同生效' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是签署中',
      config: { outcome: 'refused', message: '只有「签署中」的合同可以确认生效' },
    },
    {
      id: 'refuse_unsigned',
      type: 'end',
      label: '缺签署件或日期',
      config: { outcome: 'refused', message: '请先上传签署件并填写签署日期' },
    },
    {
      id: 'refuse_supplier',
      type: 'end',
      label: '供应商不再合格',
      config: { outcome: 'refused', message: '供应商已不是「合格」状态，合同不能生效' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认生效',
      config: {
        title: '确认合同生效：{{ contract.title }}',
        description: '合同编号：{{ contract.contract_no }}\n签署日期：{{ contract.signed_date }}\n请确认签署件为双方盖章的最终版本。',
        waitForInput: true,
      },
    },
    {
      id: 'activate',
      type: 'update_record',
      label: '置为生效',
      config: { objectName: 'srm_contract', filter: { id: cel`contract.id` }, fields: { status: 'active' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'load_supplier', type: 'default' },
    { id: 'e2', source: 'load_supplier', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_position', type: 'conditional', condition: { dialect: 'cel', source: `!(${allowed})` }, label: '没有权限' },
    {
      id: 'e4',
      source: 'gate',
      target: 'refuse_status',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && !(${signing})` },
      label: '不是签署中',
    },
    {
      id: 'e5',
      source: 'gate',
      target: 'refuse_unsigned',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && ${signing} && !(${signed})` },
      label: '未签署',
    },
    {
      id: 'e6',
      source: 'gate',
      target: 'refuse_supplier',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && ${signing} && ${signed} && !(${qualified})` },
      label: '供应商不合格',
    },
    {
      id: 'e7',
      source: 'gate',
      target: 'confirm',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && ${signing} && ${signed} && ${qualified}` },
      label: '可以',
    },
    { id: 'e8', source: 'confirm', target: 'activate', type: 'default' },
    { id: 'e9', source: 'activate', target: 'end', type: 'default' },
  ],
};
