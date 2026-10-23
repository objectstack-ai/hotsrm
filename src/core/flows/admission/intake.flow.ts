import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 1–2（03 §3）的 v0.1 版本：申请建立后，供应商进入「准入中」，申请进入「资料审核」。
// 查重与建档在登记供应商时已由唯一约束完成，这里不再重复。
export const ApplicationIntakeFlow: Automation.Flow = {
  name: 'srm_application_intake',
  label: '准入申请受理',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '申请已提交',
      config: { objectName: 'srm_supplier_application', triggerType: 'record-after-create' },
    },
    {
      id: 'supplier_qualifying',
      type: 'update_record',
      label: '供应商进入准入中',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'qualifying' } },
    },
    {
      id: 'to_doc_review',
      type: 'update_record',
      label: '申请进入资料审核',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { status: 'doc_review' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'supplier_qualifying', type: 'default' },
    { id: 'e2', source: 'supplier_qualifying', target: 'to_doc_review', type: 'default' },
    { id: 'e3', source: 'to_doc_review', target: 'end', type: 'default' },
  ],
};
