import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 8（03 §3）：申请未通过，供应商从「准入中」退回——普通申请回「潜在」，
// 重新准入（reapply）的旧档回「淘汰」。黑名单申请在受理时就已驳回，供应商一直是黑名单，不动。
export const AdmissionRejectionFlow: Automation.Flow = {
  name: 'srm_admission_rejection',
  label: '准入未通过',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '申请未通过',
      config: {
        objectName: 'srm_supplier_application',
        triggerType: 'record-after-update',
        condition: P`record.status == 'rejected' && has(previous.status) && previous.status != 'rejected' && !(has(record.duplicate_check) && record.duplicate_check == 'blacklisted')`,
      },
    },
    { id: 'by_check', type: 'decision', label: '重新准入？' },
    {
      id: 'supplier_eliminated',
      type: 'update_record',
      label: '供应商回到淘汰',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'eliminated' } },
    },
    {
      id: 'supplier_potential',
      type: 'update_record',
      label: '供应商回到潜在',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'potential' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'by_check', type: 'default' },
    {
      id: 'e_reapply',
      source: 'by_check',
      target: 'supplier_eliminated',
      type: 'conditional',
      condition: P`has(record.duplicate_check) && record.duplicate_check == 'reapply'`,
      label: '重新准入',
    },
    {
      id: 'e_new',
      source: 'by_check',
      target: 'supplier_potential',
      type: 'conditional',
      condition: P`!(has(record.duplicate_check) && record.duplicate_check == 'reapply')`,
      label: '普通申请',
    },
    { id: 'e2', source: 'supplier_eliminated', target: 'end', type: 'default' },
    { id: 'e3', source: 'supplier_potential', target: 'end', type: 'default' },
  ],
};
