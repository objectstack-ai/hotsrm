import { P } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { loadRoster, loadVendor, notifySupplier, pathOf, rosterContact, vendorName } from './supplier-notice.js';

// 门户邀请（05 §5「门户邀请」，v0.6 U6）：邀请本身是组织管理员在成员页发出的平台组织邀请（04 §3.3，flow 发不了）；
// 「开通门户」把联系人登记进名册、邀请置为已开通之后，这里告诉受邀联系人门户已经能用、下一步做什么。
// 收件人只取名册上这张邀请的联系人（名册条件同成员键：在职、portal_user 有值）。
export const PortalOpenedNoticeFlow: Automation.Flow = {
  name: 'srm_portal_opened_notice',
  label: '门户开通通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '门户邀请已开通',
      config: {
        objectName: 'srm_supplier_invitation',
        triggerType: 'record-after-update',
        condition: P`record.status == 'accepted' && has(previous.status) && previous.status == 'sent'`,
      },
    },
    loadRoster('record.supplier'),
    loadVendor('record.supplier'),
    notifySupplier('notify_contact', '通知受邀联系人：门户已开通', {
      recipients: rosterContact('record.contact'),
      template: 'srm_portal_opened',
      data: { supplier: vendorName, path: pathOf('srm_supplier', 'record.supplier') },
      sourceObject: 'srm_supplier',
      sourceId: 'record.supplier',
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e2', source: 'load_roster', target: 'load_vendor', type: 'default' },
    { id: 'e3', source: 'load_vendor', target: 'notify_contact_guard', type: 'default' },
    { id: 'e4', source: 'notify_contact_guard', target: 'end', type: 'default' },
  ],
};
