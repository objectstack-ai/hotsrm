import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 审核详情页的「转整改单」按钮（03 §13）。谁能操作、还有没有待转的问题项由 flow 自己检查。
export const AuditFindingToScarAction = defineAction({
  name: 'srm_audit_finding_to_scar',
  label: '转整改单',
  objectName: 'srm_supplier_audit',
  icon: 'clipboard-x',
  type: 'flow',
  target: 'srm_audit_finding_to_scar',
  locations: ['record_header'],
  visible: P`record.status == 'done'`,
  refreshAfter: true,
});
