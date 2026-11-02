import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { loadOrgAdmins, notifyOrgAdmins } from './org-admins.js';

// 门户邀请新建后（04 §3.3 第 1 步前）：flow 发不了组织邀请（07 §6.2 V3），所以这里只把邀请变成组织管理员的待办——
// 从联系人复制邀请邮箱、写开通期限，并通知组织管理员按邮箱在成员页邀请（角色 external），对方接受后运行「开通门户」。
// 开通期限取 INVITATION_VALID_DAYS（示例 14 天），到期仍未开通的由 srm_invitation_expire_sweep 置为已过期。
export const INVITATION_VALID_DAYS = 14;

export const InvitationSendFlow: Automation.Flow = {
  name: 'srm_invitation_send',
  label: '门户邀请待开通',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建门户邀请',
      config: { objectName: 'srm_supplier_invitation', triggerType: 'record-after-create' },
    },
    {
      id: 'load_contact',
      type: 'get_record',
      label: '读取联系人',
      config: { objectName: 'srm_supplier_contact', filter: { id: cel`record.contact` }, outputVariable: 'contact' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: ['name'], outputVariable: 'vendor' },
    },
    {
      id: 'fill',
      type: 'update_record',
      label: '写入邀请邮箱与开通期限',
      config: {
        objectName: 'srm_supplier_invitation',
        filter: { id: cel`record.id` },
        fields: {
          contact_email: cel`contact.email`,
          expires_on: { dialect: 'cel', source: `isoDate(addDays(today(), ${INVITATION_VALID_DAYS}))` },
        },
      },
    },
    loadOrgAdmins(),
    notifyOrgAdmins('notify_admins', '通知组织管理员开通', {
      title: '门户开通待办：{{ vendor.name }}',
      message:
        '门户邀请 {{ record.invitation_no }}：请在组织成员页按 {{ contact.email }} 发出邀请，角色选「external」；'
        + `对方注册并接受邀请后，在这张门户邀请上点「开通门户」。${INVITATION_VALID_DAYS} 天内未开通的邀请自动过期。`,
      sourceObject: 'srm_supplier_invitation',
      sourceId: cel`record.id`,
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_contact', type: 'default' },
    { id: 'e2', source: 'load_contact', target: 'load_supplier', type: 'default' },
    { id: 'e3', source: 'load_supplier', target: 'fill', type: 'default' },
    { id: 'e4', source: 'fill', target: 'load_org_admins', type: 'default' },
    { id: 'e5', source: 'load_org_admins', target: 'notify_admins_guard', type: 'default' },
    { id: 'e6', source: 'notify_admins_guard', target: 'end', type: 'default' },
  ],
};
