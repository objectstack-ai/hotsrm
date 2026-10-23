import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P10 资质异常与恢复（03 §11，FR-902）：证书状态或「必备」标志变化后重新计算供应商的
// qualification_alert——还有任何一张必备证书已过期就为 true，否则为 false。
// v0.1 由内部人员维护证书，暂不要求「经 SQE 核验」才解除；门户版本（v0.2）加上 verified 条件。
export const QualificationRecalcFlow: Automation.Flow = {
  name: 'srm_supplier_qualification_recalc',
  label: '资质异常重算',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '证书状态变化',
      config: {
        objectName: 'srm_supplier_certificate',
        triggerType: 'record-after-update',
        condition: P`(has(record.status) && has(previous.status) && record.status != previous.status)
          || (has(record.is_mandatory) && has(previous.is_mandatory) && record.is_mandatory != previous.is_mandatory)`,
      },
    },
    {
      id: 'find_expired_mandatory',
      type: 'get_record',
      label: '找一张已过期的必备证书',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { supplier: cel`record.supplier`, is_mandatory: true, status: 'expired' },
        outputVariable: 'expiredMandatory',
      },
    },
    { id: 'check', type: 'decision', label: '还有过期的必备证书？' },
    {
      id: 'raise_alert',
      type: 'update_record',
      label: '标记资质异常',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { qualification_alert: true } },
    },
    {
      id: 'clear_alert',
      type: 'update_record',
      label: '解除资质异常',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { qualification_alert: false } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_expired_mandatory', type: 'default' },
    { id: 'e2', source: 'find_expired_mandatory', target: 'check', type: 'default' },
    { id: 'e3', source: 'check', target: 'raise_alert', type: 'conditional', condition: P`expiredMandatory != null`, label: '有' },
    { id: 'e4', source: 'check', target: 'clear_alert', type: 'conditional', condition: P`expiredMandatory == null`, label: '没有' },
    { id: 'e5', source: 'raise_alert', target: 'end', type: 'default' },
    { id: 'e6', source: 'clear_alert', target: 'end', type: 'default' },
  ],
};
