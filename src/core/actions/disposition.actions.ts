import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 处置单草稿的「提交审批」「作废」按钮（03 §5，v0.5）。谁能操作由 flow 自己检查。
export const DispositionSubmitAction = defineAction({
  name: 'srm_disposition_submit',
  label: '提交审批',
  objectName: 'srm_supplier_disposition',
  icon: 'send',
  type: 'flow',
  target: 'srm_disposition_submit',
  locations: ['record_header'],
  visible: P`record.status == 'draft'`,
  refreshAfter: true,
});

export const DispositionCancelAction = defineAction({
  name: 'srm_disposition_cancel',
  label: '作废',
  objectName: 'srm_supplier_disposition',
  icon: 'x-circle',
  type: 'flow',
  target: 'srm_disposition_cancel',
  locations: ['record_header'],
  visible: P`record.status == 'draft'`,
  refreshAfter: true,
});
