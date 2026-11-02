import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { loadOrgAdmins, notifyOrgAdmins } from '../portal/org-admins.js';
import { clearPortalUsers, revokeInvitations } from '../portal/revoke.js';

// P1 步骤 8（03 §3）：申请未通过，供应商从「准入中」退回——普通申请回「潜在」，
// 重新准入（reapply）的旧档回「淘汰」。黑名单申请在受理时就已驳回，供应商一直是黑名单，不动。
// v0.6 起同时回收门户账号：清掉该供应商全部联系人上的 portal_user，门户邀请撤销，有门户账号时通知组织管理员撤销
// 门户岗位任命并移出组织（04 §3.3）。再申请要重新邀请、重新开通。
export const AdmissionRejectionFlow: Automation.Flow = {
  name: 'srm_admission_rejection',
  label: '准入未通过',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '申请未通过',
      config: {
        objectName: 'srm_supplier_application',
        triggerType: 'record-after-update',
        condition: P`record.status == 'rejected' && has(previous.status) && previous.status != 'rejected' && !(has(record.duplicate_check) && record.duplicate_check == 'blacklisted')`,
      },
    },
    { id: 'by_check', type: 'decision', label: '重新准入？' },
    {
      id: 'supplier_eliminated',
      type: 'update_record',
      label: '供应商回到淘汰',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'eliminated' } },
    },
    {
      id: 'supplier_potential',
      type: 'update_record',
      label: '供应商回到潜在',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'potential' } },
    },
    {
      id: 'load_portal',
      type: 'get_record',
      label: '有门户账号？',
      config: { objectName: 'srm_supplier_contact', filter: { supplier: cel`record.supplier`, portal_user: { $ne: null } }, outputVariable: 'portalContact' },
    },
    clearPortalUsers('revoke_portal', '回收门户账号', { supplier: cel`record.supplier` }),
    revokeInvitations('revoke_invitations', { supplier: cel`record.supplier` }),
    { id: 'had_portal', type: 'decision', label: '需要通知组织管理员？' },
    {
      id: 'load_vendor',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: ['name'], outputVariable: 'vendor' },
    },
    loadOrgAdmins(),
    notifyOrgAdmins('notify_admins', '通知组织管理员移除门户用户', {
      title: '门户账号已回收：{{ vendor.name }}',
      message: '准入申请 {{ record.application_no }} 未通过，{{ vendor.name }} 的门户访问已回收。请撤销该供应商门户用户的门户岗位任命，并把他们移出组织。',
      sourceObject: 'srm_supplier_application',
      sourceId: cel`record.id`,
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'by_check', type: 'default' },
    {
      id: 'e_reapply',
      source: 'by_check',
      target: 'supplier_eliminated',
      type: 'conditional',
      condition: P`has(record.duplicate_check) && record.duplicate_check == 'reapply'`,
      label: '重新准入',
    },
    {
      id: 'e_new',
      source: 'by_check',
      target: 'supplier_potential',
      type: 'conditional',
      condition: P`!(has(record.duplicate_check) && record.duplicate_check == 'reapply')`,
      label: '普通申请',
    },
    { id: 'e2', source: 'supplier_eliminated', target: 'load_portal', type: 'default' },
    { id: 'e3', source: 'supplier_potential', target: 'load_portal', type: 'default' },
    { id: 'e4', source: 'load_portal', target: 'revoke_portal', type: 'default' },
    { id: 'e5', source: 'revoke_portal', target: 'revoke_invitations', type: 'default' },
    { id: 'e6', source: 'revoke_invitations', target: 'had_portal', type: 'default' },
    { id: 'e_had', source: 'had_portal', target: 'load_vendor', type: 'conditional', condition: P`portalContact != null`, label: '有门户账号' },
    { id: 'e_none', source: 'had_portal', target: 'end', type: 'conditional', condition: P`portalContact == null`, label: '没有' },
    { id: 'e7', source: 'load_vendor', target: 'load_org_admins', type: 'default' },
    { id: 'e8', source: 'load_org_admins', target: 'notify_admins_guard', type: 'default' },
    { id: 'e9', source: 'notify_admins_guard', target: 'end', type: 'default' },
  ],
};
