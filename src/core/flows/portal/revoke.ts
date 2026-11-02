import type * as Automation from '@objectstack/spec/automation';

type Expr = unknown;

// 回收门户访问的公共节点（04 §3.3 回收，ADR-0010）。成员键只认在职联系人上的 portal_user，清掉它下一个请求起就不再
// 放行任何行；岗位任命与组织成员身份由组织管理员随后移除（系统身份的 flow 写不了任命，objectstack#25251）。
export const clearPortalUsers = (id: string, label: string, filter: Record<string, Expr>): Automation.FlowNode => ({
  id,
  type: 'update_record',
  label,
  config: {
    objectName: 'srm_supplier_contact',
    filter: { ...filter, portal_user: { $ne: null } },
    multi: true,
    fields: { portal_user: null },
  },
});

// 待开通和已开通的门户邀请一并撤销：待开通的不能再开通，已开通的在列表上显示门户已收回
export const revokeInvitations = (id: string, filter: Record<string, Expr>): Automation.FlowNode => ({
  id,
  type: 'update_record',
  label: '撤销门户邀请',
  config: {
    objectName: 'srm_supplier_invitation',
    filter: { ...filter, status: { $in: ['sent', 'accepted'] } },
    multi: true,
    fields: { status: 'revoked' },
  },
});
