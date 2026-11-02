import type * as Automation from '@objectstack/spec/automation';
import { byFunction, loadRoster, loadVendor, notifySupplier, pathOf, vendorName } from '../portal/supplier-notice.js';
import { APPEAL_DAYS } from './params.js';

// 绩效结果通知供应商（05 §5「绩效结果发布；申诉处理结果」加供应商 admin 联系人，v0.6 U6）：考评单经采购总监审定发布、
// 申诉处理完回到已发布时，发给该供应商名册上的主账号（admin）联系人。门户只看得到已发布、申诉中的考评单（04 §3.2），
// 通知里也只写单号和期间，不写分数和等级。内部评分人、申诉代录人的通知仍在 srm_performance_publish、srm_appeal_resolve 里。
const SOURCE = 'srm_performance_review';
const published = `record.status == 'published' && has(previous.status) && previous.status == 'reviewing'`;
const resolved = `record.status == 'published' && has(previous.status) && previous.status == 'appealed'`;

export const ReviewSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_review_supplier_notice',
  label: '绩效结果通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '考评单发布或申诉处理完',
      config: { objectName: SOURCE, triggerType: 'record-after-update', condition: { dialect: 'cel', source: `(${published}) || (${resolved})` } },
    },
    loadRoster('record.supplier'),
    loadVendor('record.supplier'),
    { id: 'by_event', type: 'decision', label: '发布还是申诉结果？' },
    notifySupplier('notify_published', '通知供应商主账号：绩效已发布', {
      recipients: byFunction('admin'),
      template: 'srm_review_published',
      data: { no: 'record.review_no', supplier: vendorName, period: 'record.period', appeal_days: `'${APPEAL_DAYS}'`, path: pathOf(SOURCE, 'record.id') },
      sourceObject: SOURCE,
      sourceId: 'record.id',
    }),
    notifySupplier('notify_resolved', '通知供应商主账号：申诉已处理', {
      recipients: byFunction('admin'),
      template: 'srm_appeal_resolved',
      data: { no: 'record.review_no', supplier: vendorName, period: 'record.period', path: pathOf(SOURCE, 'record.id') },
      sourceObject: SOURCE,
      sourceId: 'record.id',
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e2', source: 'load_roster', target: 'load_vendor', type: 'default' },
    { id: 'e3', source: 'load_vendor', target: 'by_event', type: 'default' },
    { id: 'e_published', source: 'by_event', target: 'notify_published_guard', type: 'conditional', condition: { dialect: 'cel', source: published }, label: '发布' },
    { id: 'e_resolved', source: 'by_event', target: 'notify_resolved_guard', type: 'conditional', condition: { dialect: 'cel', source: resolved }, label: '申诉结果' },
    { id: 'e4', source: 'notify_published_guard', target: 'end', type: 'default' },
    { id: 'e5', source: 'notify_resolved_guard', target: 'end', type: 'default' },
  ],
};
