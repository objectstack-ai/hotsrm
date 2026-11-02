import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 作废处置单草稿（03 §5，v0.5）：品类经理或采购主管核实后认为不必处置时作废草稿，写明理由。只作废草稿，
// 审批中的处置单走审批（驳回）。以系统身份运行，进门检查同 srm_disposition_submit。
// 作废理由记在驳回原因字段（reject_reason），处置单上只有这一个「为什么没执行」的字段。
const allowed = `current_user != null && ('srm_category_manager' in current_user.positions || 'srm_buyer_lead' in current_user.positions)`;
const isDraft = `disp != null && disp.status == 'draft'`;
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });

export const DispositionCancelFlow: Automation.Flow = {
  name: 'srm_disposition_cancel',
  label: '作废处置单草稿',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '处置单草稿已作废',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取处置单',
      config: { objectName: 'srm_supplier_disposition', filter: { id: cel`recordId` }, outputVariable: 'disp' },
    },
    { id: 'gate', type: 'decision', label: '可以作废？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '没有作废权限',
      config: { outcome: 'refused', message: '只有品类经理或采购主管可以作废处置单草稿' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是草稿',
      config: { outcome: 'refused', message: '只有草稿可以作废，审批中的处置单由审批人驳回' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认作废',
      config: {
        title: '作废处置单草稿：{{ disp.disposition_no }}',
        description: '作废后这张草稿不再提交审批，供应商状态不变。',
        fields: [{ name: 'cancel_reason', label: '作废理由', type: 'textarea', required: true }],
        waitForInput: true,
      },
    },
    {
      id: 'cancel',
      type: 'update_record',
      label: '置为已作废',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`disp.id` },
        fields: { status: 'cancelled', reject_reason: cel`cancel_reason` },
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
    { id: 'e5', source: 'confirm', target: 'cancel', type: 'default' },
    { id: 'e6', source: 'cancel', target: 'end', type: 'default' },
  ],
};
