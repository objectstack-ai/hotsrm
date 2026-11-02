import type * as Automation from '@objectstack/spec/automation';
import { loadRoster, loadVendor, notifySupplier, pathOf, rosterContact, vendorName } from '../portal/supplier-notice.js';

// 准入申请进展通知供应商（05 §5「准入申请已受理 / 已通过」与 03 §3 第 4 步「退回补充」，v0.6 U6）。「未通过」在
// srm_admission_rejection 回收门户之前发（回收后名册上就没有申请联系人了）。
// 收件人是申请联系人（门户提交时由 srm_application_submit 写入的名册行）在名册上的门户账号，不发 created_by；
// 联系人停用或门户被收回后名册上没有这一行，就不再发。内部登记的申请没有申请联系人，不发供应商，内部通知不变。
// 受理 = 资料审核首次开始（从「已提交」进入）；从「退回补充」回到资料审核是供应商自己重新提交的，不再通知。
const SOURCE = 'srm_supplier_application';
const changedTo = (status: string) => `record.status == '${status}' && has(previous.status) && previous.status != '${status}'`;
const accepted = `record.status == 'doc_review' && has(previous.status) && previous.status == 'submitted'`;
const events: Array<[key: string, condition: string, template: string, label: string]> = [
  ['accepted', accepted, 'srm_application_accepted', '已受理'],
  ['returned', changedTo('returned'), 'srm_application_returned', '退回补充'],
  ['approved', changedTo('approved'), 'srm_application_approved', '已通过'],
];

export const ApplicationSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_application_supplier_notice',
  label: '准入申请进展通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '门户提交的申请受理、退回补充或通过',
      config: {
        objectName: SOURCE,
        triggerType: 'record-after-update',
        condition: {
          dialect: 'cel',
          source: `has(record.contact) && record.contact != null && (${events.map(([, cond]) => `(${cond})`).join(' || ')})`,
        },
      },
    },
    loadRoster('record.supplier'),
    loadVendor('record.supplier'),
    { id: 'by_event', type: 'decision', label: '哪一种进展？' },
    ...events.map(([key, , template, label]) =>
      notifySupplier(`notify_${key}`, `通知申请联系人：${label}`, {
        recipients: rosterContact('record.contact'),
        template,
        data: { no: 'record.application_no', supplier: vendorName, path: pathOf(SOURCE, 'record.id') },
        sourceObject: SOURCE,
        sourceId: 'record.id',
      }),
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e3', source: 'load_roster', target: 'load_vendor', type: 'default' },
    { id: 'e4', source: 'load_vendor', target: 'by_event', type: 'default' },
    ...events.flatMap(([key, condition, , label]) => [
      { id: `e_${key}`, source: 'by_event', target: `notify_${key}_guard`, type: 'conditional' as const, condition: { dialect: 'cel' as const, source: condition }, label },
      { id: `e_${key}_end`, source: `notify_${key}_guard`, target: 'end', type: 'default' as const },
    ]),
  ],
};
