import type * as Automation from '@objectstack/spec/automation';
import { byFunction, loadRoster, loadVendor, notifySupplier, pathOf, vendorName } from '../portal/supplier-notice.js';

// 冻结 / 解冻结果通知供应商（03 §5「通知供应商」，v0.6 U6）：处置单执行后发给该供应商名册上的主账号（admin）联系人。
// 处置单本身不对门户开放（04 §3.2），通知链接到公司资料，只写冻结范围，不写处置原因。淘汰、拉入黑名单在
// srm_disposition_apply 回收门户之前发（回收后名册就空了）；解除黑名单时门户早已回收，不发。
const SOURCE = 'srm_supplier_disposition';
const applied = (action: string) => `record.status == 'applied' && has(previous.status) && previous.status != 'applied' && record.action == '${action}'`;
// 范围两种语言都看得懂，不随收件人语言变
const scope = `has(record.scope) && record.scope == 'category' ? '部分品类 / some categories' : '全部品类 / all categories'`;

export const DispositionSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_disposition_supplier_notice',
  label: '冻结与解冻通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '冻结或解冻处置单已执行',
      config: { objectName: SOURCE, triggerType: 'record-after-update', condition: { dialect: 'cel', source: `(${applied('freeze')}) || (${applied('unfreeze')})` } },
    },
    loadRoster('record.supplier'),
    loadVendor('record.supplier'),
    { id: 'by_action', type: 'decision', label: '冻结还是解冻？' },
    ...(['freeze', 'unfreeze'] as const).map((action) =>
      notifySupplier(`notify_${action}`, `通知供应商主账号：${action === 'freeze' ? '已冻结' : '已解冻'}`, {
        recipients: byFunction('admin'),
        template: action === 'freeze' ? 'srm_supplier_frozen' : 'srm_supplier_unfrozen',
        data: { supplier: vendorName, scope, path: pathOf('srm_supplier', 'record.supplier') },
        sourceObject: 'srm_supplier',
        sourceId: 'record.supplier',
      }),
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e2', source: 'load_roster', target: 'load_vendor', type: 'default' },
    { id: 'e3', source: 'load_vendor', target: 'by_action', type: 'default' },
    { id: 'e_freeze', source: 'by_action', target: 'notify_freeze_guard', type: 'conditional', condition: { dialect: 'cel', source: `record.action == 'freeze'` }, label: '冻结' },
    { id: 'e_unfreeze', source: 'by_action', target: 'notify_unfreeze_guard', type: 'conditional', condition: { dialect: 'cel', source: `record.action == 'unfreeze'` }, label: '解冻' },
    { id: 'e4', source: 'notify_freeze_guard', target: 'end', type: 'default' },
    { id: 'e5', source: 'notify_unfreeze_guard', target: 'end', type: 'default' },
  ],
};
