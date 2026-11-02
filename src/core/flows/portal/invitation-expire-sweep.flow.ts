import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 每日追赶式扫描（03 §13）：过了开通期限仍「已发送」的门户邀请置为「已过期」。重复运行不重复处理（03 §2.3 R2）。
// 组织邀请本身的有效期由平台管理；要继续开通的，品类经理新建一张门户邀请
export const InvitationExpireSweepFlow: Automation.Flow = {
  name: 'srm_invitation_expire_sweep',
  label: '门户邀请过期扫描',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每日 01:20', config: { schedule: '20 1 * * *' } },
    {
      id: 'expire',
      type: 'update_record',
      label: '置为已过期',
      config: {
        objectName: 'srm_supplier_invitation',
        filter: { status: 'sent', expires_on: { $lt: cel`isoDate(today())` } },
        multi: true,
        fields: { status: 'expired' },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'expire', type: 'default' },
    { id: 'e2', source: 'expire', target: 'end', type: 'default' },
  ],
};
