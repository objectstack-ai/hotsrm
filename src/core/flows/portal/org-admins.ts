import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 组织管理员（组织角色 owner / admin）：只有他们能发组织邀请、写门户岗位任命（07 §6.2 V2、V3），
// 所以门户开通需求和回收后的善后都通知他们（04 §3.3）。以系统身份运行的 flow 读成员表
export const ORG_ADMIN_ROLES = ['owner', 'admin'];

export const loadOrgAdmins = (id = 'load_org_admins'): Automation.FlowNode => ({
  id,
  type: 'get_record',
  label: '读取组织管理员',
  config: { objectName: 'sys_member', filter: { role: { $in: ORG_ADMIN_ROLES } }, limit: 50, outputVariable: 'orgAdmins' },
});

// 通知失败不影响业务写入：包在 try_catch 里
export const notifyOrgAdmins = (
  id: string,
  label: string,
  config: { title: string; message: string; sourceObject: string; sourceId: ReturnType<typeof cel> },
): Automation.FlowNode => ({
  id: `${id}_guard`,
  type: 'try_catch',
  label,
  config: {
    try: {
      nodes: [
        {
          id,
          type: 'notify',
          label,
          config: { recipients: cel`orgAdmins.map(m, m.user_id)`, severity: 'warning', ...config },
        },
      ],
    },
    catch: { nodes: [{ id: `${id}_skip`, type: 'assignment', label: '跳过通知' }] },
  },
} as Automation.FlowNode);
