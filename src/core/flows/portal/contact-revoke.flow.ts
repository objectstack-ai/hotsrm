import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { loadOrgAdmins, notifyOrgAdmins } from './org-admins.js';
import { clearPortalUsers, revokeInvitations } from './revoke.js';

// 联系人停用时收回门户账号（04 §3.3 回收）：在职标志本身就是名册的过滤条件，停用即刻看不到数据；这里再清掉 portal_user，
// 免得日后有人把联系人改回在职时静默恢复门户访问——重新开通一律走门户邀请和「开通门户」。该联系人的门户邀请撤销，
// 并通知组织管理员撤销门户岗位任命、把该用户移出组织。
export const PortalContactRevokeFlow: Automation.Flow = {
  name: 'srm_portal_contact_revoke',
  label: '联系人停用收回门户账号',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '开通了门户的联系人停用',
      config: {
        objectName: 'srm_supplier_contact',
        triggerType: 'record-after-update',
        condition: P`record.active == false && has(previous.active) && previous.active == true && has(record.portal_user) && record.portal_user != null`,
      },
    },
    clearPortalUsers('clear', '清掉门户账号', { id: cel`record.id` }),
    revokeInvitations('revoke_invitations', { contact: cel`record.id` }),
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: ['name'], outputVariable: 'vendor' },
    },
    loadOrgAdmins(),
    notifyOrgAdmins('notify_admins', '通知组织管理员撤销任命', {
      title: '门户账号已收回：{{ vendor.name }} {{ record.name }}',
      message: '联系人 {{ record.name }}（{{ record.email }}）已停用，门户访问已收回。请撤销该用户的门户岗位任命，并把该用户移出组织。',
      sourceObject: 'srm_supplier_contact',
      sourceId: cel`record.id`,
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'clear', type: 'default' },
    { id: 'e2', source: 'clear', target: 'revoke_invitations', type: 'default' },
    { id: 'e3', source: 'revoke_invitations', target: 'load_supplier', type: 'default' },
    { id: 'e4', source: 'load_supplier', target: 'load_org_admins', type: 'default' },
    { id: 'e5', source: 'load_org_admins', target: 'notify_admins_guard', type: 'default' },
    { id: 'e6', source: 'notify_admins_guard', target: 'end', type: 'default' },
  ],
};
