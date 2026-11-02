import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_invitation' };
const columns = [
  { field: 'invitation_no' },
  { field: 'supplier' },
  { field: 'contact' },
  { field: 'contact_email' },
  { field: 'status' },
  { field: 'expires_on' },
  { field: 'created_by' },
  { field: 'enabled_at' },
];

export const SupplierInvitationViews = defineView({
  list: {
    label: '全部门户邀请',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'invitation_no', order: 'desc' }],
  },

  listViews: {
    // 组织管理员的待办：按邀请邮箱在成员页发邀请，对方接受后点「开通门户」（04 §3.3）
    sent: {
      label: '待开通',
      type: 'grid',
      data,
      columns,
      sort: [{ field: 'expires_on', order: 'asc' }],
      filter: [{ field: 'status', operator: 'equals', value: 'sent' }],
    },
    accepted: {
      label: '已开通',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'accepted' }],
    },
  },
});
