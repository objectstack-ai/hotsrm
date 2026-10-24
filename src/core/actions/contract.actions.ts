import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 合同详情页的「提交审批」「确认生效」按钮（03 §6）。谁能操作由 flow 自己检查。
export const ContractSubmitAction = defineAction({
  name: 'srm_contract_submit',
  label: '提交审批',
  objectName: 'srm_contract',
  icon: 'send',
  type: 'flow',
  target: 'srm_contract_submit',
  locations: ['record_header'],
  visible: P`record.status == 'draft'`,
  refreshAfter: true,
});

export const ContractActivateAction = defineAction({
  name: 'srm_contract_activate',
  label: '确认生效',
  objectName: 'srm_contract',
  icon: 'file-check',
  type: 'flow',
  target: 'srm_contract_activate',
  locations: ['record_header'],
  visible: P`record.status == 'signing'`,
  refreshAfter: true,
});
