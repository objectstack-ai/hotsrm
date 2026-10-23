import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 8（03 §3）：申请未通过，供应商从「准入中」回到「潜在」。
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
        condition: P`record.status == 'rejected' && has(previous.status) && previous.status != 'rejected'`,
      },
    },
    {
      id: 'supplier_potential',
      type: 'update_record',
      label: '供应商回到潜在',
      config: {
        objectName: 'srm_supplier',
        filter: { id: cel`record.supplier` },
        fields: { status: 'potential' },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'supplier_potential', type: 'default' },
    { id: 'e2', source: 'supplier_potential', target: 'end', type: 'default' },
  ],
};
