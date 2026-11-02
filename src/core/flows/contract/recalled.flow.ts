import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 撤回的合同回到草稿（03 §6 第 2 步）：提交人在审批中或被退回修改期间撤回审批，审批节点把审批结论写成
// 「已撤回」。审批中撤回时 srm_contract_approval 自己走到结束，被退回修改期间撤回时平台直接取消那次审批流程，
// 两种情况都由这里把状态改回草稿，改完可以重新提交。
export const ContractRecalledFlow: Automation.Flow = {
  name: 'srm_contract_recalled',
  label: '撤回的合同回到草稿',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '审批已撤回',
      config: {
        objectName: 'srm_contract',
        triggerType: 'record-after-update',
        condition: P`record.status == 'in_review' && record.approval_status == 'recalled' && has(previous.approval_status) && previous.approval_status != 'recalled'`,
      },
    },
    {
      id: 'back_to_draft',
      type: 'update_record',
      label: '回到草稿',
      config: { objectName: 'srm_contract', filter: { id: cel`record.id` }, fields: { status: 'draft' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'back_to_draft', type: 'default' },
    { id: 'e2', source: 'back_to_draft', target: 'end', type: 'default' },
  ],
};
