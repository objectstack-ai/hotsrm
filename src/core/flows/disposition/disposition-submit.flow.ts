import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 提交处置单草稿（03 §5，v0.5）：flow 生成的草稿（高风险事件、绩效结果应用）由品类经理或采购主管核对后
// 提交，草稿 → 审批中，srm_disposition_approval 随即以提交人为发起人开始审批。以系统身份运行，因为状态对所有人
// 只读；进门的检查在 flow 里做（临时做法同 srm_contract_submit：平台还不能在 flow 上声明谁可以启动，objectstack#25481）。
// 提交人记入 submitted_by 并接管记录所有权（处置单 OWD 为 private，退回修改时提交人要能改原因）。
// 供应商状态是否还允许这个动作、是否已有审批中的处置单，由处置单上的 *_on_submit 校验规则把关。
const allowed = `current_user != null && ('srm_category_manager' in current_user.positions || 'srm_buyer_lead' in current_user.positions)`;
const isDraft = `disp != null && disp.status == 'draft'`;
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });

export const DispositionSubmitFlow: Automation.Flow = {
  name: 'srm_disposition_submit',
  label: '提交处置单',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '处置单已提交审批',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取处置单',
      config: { objectName: 'srm_supplier_disposition', filter: { id: cel`recordId` }, outputVariable: 'disp' },
    },
    { id: 'gate', type: 'decision', label: '可以提交？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '没有提交权限',
      config: { outcome: 'refused', message: '只有品类经理或采购主管可以提交处置单' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是草稿',
      config: { outcome: 'refused', message: '只有草稿处置单需要提交，新建的处置单已在审批中' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认提交',
      config: {
        title: '提交处置单：{{ disp.disposition_no }}',
        description: '处置原因：{{ disp.reason }}\n提交后进入审批，你是这张处置单的发起人。原因不合适时请作废草稿、手工新建处置单。',
        waitForInput: true,
      },
    },
    {
      id: 'submit',
      type: 'update_record',
      label: '置为审批中',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`disp.id` },
        fields: { status: 'in_review', submitted_by: cel`current_user.id`, owner_id: cel`current_user.id` },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: cel$(`!(${allowed})`), label: '没有权限' },
    { id: 'e3', source: 'gate', target: 'refuse_status', type: 'conditional', condition: cel$(`${allowed} && !(${isDraft})`), label: '不是草稿' },
    { id: 'e4', source: 'gate', target: 'confirm', type: 'conditional', condition: cel$(`${allowed} && ${isDraft}`), label: '可以' },
    { id: 'e5', source: 'confirm', target: 'submit', type: 'default' },
    { id: 'e6', source: 'submit', target: 'end', type: 'default' },
  ],
};
