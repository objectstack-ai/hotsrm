import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 问题复发（02 §5.6 closed → open）：重新打开的整改单从头走 8D，期限按重开时间重算（与新建时相同的参数：
// scar_containment_hours、scar_final_days），逾期标志清掉，由逾期扫描重新判断；通知负责 SQE。
export const ScarReopenFlow: Automation.Flow = {
  name: 'srm_scar_reopen',
  label: '整改单重新打开',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '已关闭的整改单重新打开',
      config: {
        objectName: 'srm_quality_issue',
        triggerType: 'record-after-update',
        condition: P`record.status == 'open' && has(previous.status) && previous.status == 'closed'`,
      },
    },
    {
      id: 'reset_due',
      type: 'update_record',
      label: '重算期限',
      config: {
        objectName: 'srm_quality_issue',
        filter: { id: cel`record.id` },
        fields: {
          containment_due: cel`now() + duration('72h')`,
          final_due: cel`addDays(today(), 30)`,
          is_overdue: false,
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
              id: 'notify_reopened',
              type: 'notify',
              label: '通知 SQE：整改单重新打开',
              config: {
                recipients: cel`has(record.sqe) && record.sqe != null ? record.sqe : null`,
                title: '整改单 {{ record.issue_no }} 因问题复发重新打开',
                message: '请联系供应商重新提交临时措施（D3）和根因与措施（D4–D7），期限已按重开时间重算。',
                severity: 'warning',
                sourceObject: 'srm_quality_issue',
                sourceId: cel`record.id`,
              },
            },
          ],
        },
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'reset_due', type: 'default' },
    { id: 'e2', source: 'reset_due', target: 'notify_guard', type: 'default' },
    { id: 'e3', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
