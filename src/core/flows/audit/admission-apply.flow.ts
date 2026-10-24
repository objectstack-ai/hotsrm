import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 5（03 §3，FR-204）：准入审核完成（或完成后改了结论）时，把结论写回关联的准入申请：通过或
// 有条件通过时 audit_passed = true，否则 false；有条件通过的申请批准后品类资格为「试供」（WI-01 6.6.2）。
// 申请不在进行中（已批准、已驳回）时不写；同时通知申请的初审人（品类经理）。
const finished = (r: string) => `${r}.audit_type == 'admission' && ${r}.status == 'done' && has(${r}.application) && ${r}.application != null`;

export const AuditAdmissionApplyFlow: Automation.Flow = {
  name: 'srm_audit_admission_apply',
  label: '准入审核结论写回申请',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '准入审核完成',
      config: {
        objectName: 'srm_supplier_audit',
        triggerType: 'record-after-write',
        condition: {
          dialect: 'cel',
          source:
            `${finished('record')} && (previous == null || !(${finished('previous')}) || previous.result != record.result`
            + ` || previous.application != record.application)`,
        },
      },
    },
    {
      id: 'load_application',
      type: 'get_record',
      label: '读取准入申请',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.application` }, outputVariable: 'app' },
    },
    { id: 'open', type: 'decision', label: '申请进行中？' },
    {
      id: 'write_back',
      type: 'update_record',
      label: '写回审核结论',
      config: {
        objectName: 'srm_supplier_application',
        filter: { id: cel`app.id` },
        fields: {
          audit_passed: cel`record.result == 'pass' || record.result == 'conditional'`,
          audit_result: cel`record.result`,
        },
      },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_reviewer',
              type: 'notify',
              label: '通知初审人',
              config: {
                recipients: [cel`has(app.reviewer) && app.reviewer != null ? app.reviewer : null`],
                title: '准入申请 {{ app.application_no }} 的现场审核已完成',
                message: '审核 {{ record.audit_no }} 结论已写回准入申请。结论为通过或有条件通过时，申请可以进入准入评审；不通过时不能进入准入评审。',
                severity: 'info',
                sourceObject: 'srm_supplier_application',
                sourceId: cel`app.id`,
              },
            },
          ],
        },
        // 申请没有初审人时不影响写回
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_application', type: 'default' },
    { id: 'e2', source: 'load_application', target: 'open', type: 'default' },
    {
      id: 'e_open',
      source: 'open',
      target: 'write_back',
      type: 'conditional',
      condition: P`app != null && app.status != 'approved' && app.status != 'rejected'`,
      label: '进行中',
    },
    {
      id: 'e_closed',
      source: 'open',
      target: 'end',
      type: 'conditional',
      condition: P`app == null || app.status == 'approved' || app.status == 'rejected'`,
      label: '已结束',
    },
    { id: 'e3', source: 'write_back', target: 'notify_guard', type: 'default' },
    { id: 'e4', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
