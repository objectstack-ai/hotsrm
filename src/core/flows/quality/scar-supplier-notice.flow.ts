import type * as Automation from '@objectstack/spec/automation';
import { byFunction, loadRoster, loadVendor, notifySupplier, pathOf, vendorName } from '../portal/supplier-notice.js';

// 整改单通知供应商（05 §5「新整改单、整改退回、整改重开、整改逾期」加供应商 quality 联系人，v0.6 U6）：
// 不论整改单从哪里来（来料不合格自动开单、审核问题项转单、SQE 手工新建），新建、SQE 退回根因与措施、关闭后重新打开、
// 被逾期扫描标记逾期，都发给该供应商名册上的质量联系人（没有质量联系人时发主账号联系人）。内部 SQE / 质量经理的通知
// 仍在 srm_scar_create、srm_scar_review、srm_scar_reopen、srm_scar_overdue_sweep 里，不变。
const SOURCE = 'srm_quality_issue';
const events: Array<[key: string, condition: string, template: string, label: string]> = [
  ['new', `previous == null`, 'srm_scar_new', '新整改单'],
  [
    'returned',
    `previous != null && record.status == 'containment_submitted' && has(previous.status) && previous.status == 'action_submitted'`,
    'srm_scar_returned',
    '整改退回',
  ],
  ['reopened', `previous != null && record.status == 'open' && has(previous.status) && previous.status == 'closed'`, 'srm_scar_reopened', '整改重开'],
  [
    'overdue',
    `previous != null && record.is_overdue == true && !(has(previous.is_overdue) && previous.is_overdue == true)`,
    'srm_scar_overdue',
    '整改逾期',
  ],
];

export const ScarSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_scar_supplier_notice',
  label: '整改单通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '整改单新建、退回、重开或逾期',
      config: {
        objectName: SOURCE,
        triggerType: 'record-after-write',
        condition: { dialect: 'cel', source: events.map(([, cond]) => `(${cond})`).join(' || ') },
      },
    },
    // 重开、退回时整改单上的期限由别的 flow 刚刚重算或写过：从库里重读一遍，模板拿到的是最新期限
    {
      id: 'load_issue',
      type: 'get_record',
      label: '读取整改单当前期限',
      config: { objectName: SOURCE, filter: { id: { dialect: 'cel', source: 'record.id' } }, fields: ['id', 'issue_no', 'containment_due', 'final_due'], outputVariable: 'issue' },
    },
    loadRoster('record.supplier'),
    loadVendor('record.supplier'),
    { id: 'by_event', type: 'decision', label: '哪一种事件？' },
    ...events.map(([key, , template, label]) =>
      notifySupplier(`notify_${key}`, `通知供应商质量联系人：${label}`, {
        recipients: byFunction('quality'),
        template,
        data: {
          no: 'issue.issue_no',
          supplier: vendorName,
          containment_due: `has(issue.containment_due) && issue.containment_due != null ? string(issue.containment_due) : '-'`,
          final_due: `has(issue.final_due) && issue.final_due != null ? string(issue.final_due) : '-'`,
          path: pathOf(SOURCE, 'record.id'),
        },
        sourceObject: SOURCE,
        sourceId: 'record.id',
      }),
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_issue', type: 'default' },
    { id: 'e2', source: 'load_issue', target: 'load_roster', type: 'default' },
    { id: 'e3', source: 'load_roster', target: 'load_vendor', type: 'default' },
    { id: 'e4', source: 'load_vendor', target: 'by_event', type: 'default' },
    ...events.flatMap(([key, condition, , label]) => [
      { id: `e_${key}`, source: 'by_event', target: `notify_${key}_guard`, type: 'conditional' as const, condition: { dialect: 'cel' as const, source: condition }, label },
      { id: `e_${key}_end`, source: `notify_${key}_guard`, target: 'end', type: 'default' as const },
    ]),
  ],
};
