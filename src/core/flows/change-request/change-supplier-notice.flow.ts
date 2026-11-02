import type * as Automation from '@objectstack/spec/automation';
import { loadPortalAdmins, loadRoster, loadVendor, notifySupplier, pathOf, portalAdmins, vendorName } from '../portal/supplier-notice.js';

// 信息变更单结果通知供应商（05 §5「银行账户与变更单结果」，v0.6 U6）：变更单生效、驳回或退回修改时，发给该供应商名册上的
// 门户管理员（关键信息由门户管理员经「提交变更申请」提交，退回的由门户管理员改完重新提交，04 §3.2）。
// 内部发起人的通知仍在 srm_change_approval 里；发起人本人是门户用户时那边不再发，只收这里的中英文通知。
const SOURCE = 'srm_supplier_change_request';
const events: Array<[key: string, condition: string, template: string, label: string]> = [
  ['applied', `record.status == 'applied' && has(previous.status) && previous.status != 'applied'`, 'srm_change_applied', '已生效'],
  ['rejected', `record.status == 'rejected' && has(previous.status) && previous.status != 'rejected'`, 'srm_change_rejected', '已驳回'],
  [
    'returned',
    `record.approval_status == 'returned' && !(has(previous.approval_status) && previous.approval_status == 'returned')`,
    'srm_change_returned',
    '退回修改',
  ],
];

export const ChangeSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_change_supplier_notice',
  label: '变更单结果通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '变更单生效、驳回或退回修改',
      config: {
        objectName: SOURCE,
        triggerType: 'record-after-update',
        condition: { dialect: 'cel', source: events.map(([, cond]) => `(${cond})`).join(' || ') },
      },
    },
    loadRoster('record.supplier'),
    loadPortalAdmins(),
    loadVendor('record.supplier'),
    { id: 'by_event', type: 'decision', label: '哪一种结果？' },
    ...events.map(([key, , template, label]) =>
      notifySupplier(`notify_${key}`, `通知供应商门户管理员：${label}`, {
        recipients: portalAdmins,
        template,
        data: { no: 'record.change_no', supplier: vendorName, path: pathOf(SOURCE, 'record.id') },
        sourceObject: SOURCE,
        sourceId: 'record.id',
      }),
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e2', source: 'load_roster', target: 'load_portal_admins', type: 'default' },
    { id: 'e3', source: 'load_portal_admins', target: 'load_vendor', type: 'default' },
    { id: 'e4', source: 'load_vendor', target: 'by_event', type: 'default' },
    ...events.flatMap(([key, condition, , label]) => [
      { id: `e_${key}`, source: 'by_event', target: `notify_${key}_guard`, type: 'conditional' as const, condition: { dialect: 'cel' as const, source: condition }, label },
      { id: `e_${key}_end`, source: `notify_${key}_guard`, target: 'end', type: 'default' as const },
    ]),
  ],
};
