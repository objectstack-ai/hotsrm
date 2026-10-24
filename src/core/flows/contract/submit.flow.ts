import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 提交合同审批（03 §6 第 2 步）：草稿 → 审批中。审批本身由 srm_contract_approval 在状态变为「审批中」时
// 发起（v0.3 C2）。以系统身份运行，因为状态对所有人只读；进门的检查都在 flow 里做（品类经理、采购主管，
// 只提交草稿）。临时做法同 srm_bank_verify：平台还不能在 flow 上声明谁可以启动（objectstack#25481）。
const allowed = `current_user != null && ('srm_category_manager' in current_user.positions || 'srm_buyer_lead' in current_user.positions)`;

export const ContractSubmitFlow: Automation.Flow = {
  name: 'srm_contract_submit',
  label: '提交合同审批',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '合同已提交审批',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取合同',
      config: { objectName: 'srm_contract', filter: { id: cel`recordId` }, outputVariable: 'contract' },
    },
    { id: 'gate', type: 'decision', label: '可以提交？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '没有提交权限',
      config: { outcome: 'refused', message: '只有品类经理或采购主管可以提交合同审批' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是草稿',
      config: { outcome: 'refused', message: '只有草稿合同可以提交审批' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认提交',
      config: {
        title: '提交合同审批：{{ contract.title }}',
        description: '合同编号：{{ contract.contract_no }}\n提交后合同内容与明细不能再修改，审批退回后才能改。',
        waitForInput: true,
      },
    },
    {
      id: 'submit',
      type: 'update_record',
      label: '置为审批中',
      config: { objectName: 'srm_contract', filter: { id: cel`contract.id` }, fields: { status: 'in_review' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: { dialect: 'cel', source: `!(${allowed})` }, label: '没有权限' },
    {
      id: 'e3',
      source: 'gate',
      target: 'refuse_status',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && (contract == null || contract.status != 'draft')` },
      label: '不是草稿',
    },
    {
      id: 'e4',
      source: 'gate',
      target: 'confirm',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && contract != null && contract.status == 'draft'` },
      label: '可以',
    },
    { id: 'e5', source: 'confirm', target: 'submit', type: 'default' },
    { id: 'e6', source: 'submit', target: 'end', type: 'default' },
  ],
};
