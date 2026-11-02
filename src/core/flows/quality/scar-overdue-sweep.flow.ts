import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 每条整改单一次更新、一次通知，失败只跳过该条，不中断整次扫描
const eachIssue = (key: string, collection: ReturnType<typeof cel>, title: string, message: string): Automation.FlowNode => ({
  id: `each_${key}`,
  type: 'loop',
  label: '逐条置逾期并通知',
  config: {
    collection,
    iteratorVariable: 'issue',
    body: {
      nodes: [
        {
          id: `guard_${key}`,
          type: 'try_catch',
          label: '单条整改单',
          config: {
            try: {
              nodes: [
                {
                  id: `flag_${key}`,
                  type: 'update_record',
                  label: '置为逾期',
                  config: { objectName: 'srm_quality_issue', filter: { id: cel`issue.id` }, fields: { is_overdue: true } },
                },
                {
                  id: `notify_${key}`,
                  type: 'notify',
                  label: '通知 SQE 与质量经理',
                  config: {
                    recipients: [cel`has(issue.sqe) && issue.sqe != null ? issue.sqe : null`, cel`qualityManagers.map(p, p.user_id)`],
                    title,
                    message,
                    severity: 'warning',
                    sourceObject: 'srm_quality_issue',
                    sourceId: cel`issue.id`,
                  },
                },
              ],
              edges: [{ id: `e_flag_${key}`, source: `flag_${key}`, target: `notify_${key}`, type: 'default' }],
            },
            catch: { nodes: [{ id: `skip_${key}`, type: 'assignment', label: '跳过该条' }] },
          },
        },
      ],
    },
  },
});

// P7 步骤 5（03 §8，FR-605）：追赶式扫描，超过临时措施期限仍「待供应商响应」、或超过最终回复期限仍未进入
// 效果验证的整改单置为逾期，通知负责 SQE 与质量经理（SQE 主管）。只处理还没标记逾期的整改单，
// 重复运行不重复通知（03 §2.3 R2）；标志保留到关闭，供「SCAR 按期关闭率」统计（05 §4.1）。
// 每小时跑一次。外部心跳（03 §2.3 R3）暂缺：api 触发的 flow 只能把签名密钥写死在元数据里，公开仓库不能这么做
// （objectstack#25675），平台支持部署时注入密钥后再加 srm_scar_overdue_heartbeat。
// 供应商的提醒等 objectstack#25444 或 v0.6 门户上线后再加。
export const ScarOverdueSweepFlow: Automation.Flow = {
  name: 'srm_scar_overdue_sweep',
  label: '整改逾期扫描',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每小时', config: { schedule: '5 * * * *' } },
    {
      id: 'load_quality_managers',
      type: 'get_record',
      label: '读取质量经理',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
    },
    {
      id: 'find_containment',
      type: 'get_record',
      label: '临时措施逾期',
      config: {
        objectName: 'srm_quality_issue',
        filter: { status: 'open', is_overdue: false, containment_due: { $lt: cel`isoDatetime(now())` } },
        limit: 500,
        outputVariable: 'containmentList',
      },
    },
    eachIssue(
      'containment',
      cel`containmentList`,
      '整改单 {{ issue.issue_no }} 临时措施已逾期',
      '临时措施（D3）期限 {{ issue.containment_due }} 已过，供应商仍未提交。请督促供应商尽快提交。',
    ),
    {
      id: 'find_final',
      type: 'get_record',
      label: '最终回复逾期',
      config: {
        objectName: 'srm_quality_issue',
        filter: {
          status: { $in: ['open', 'containment_submitted', 'action_submitted'] },
          is_overdue: false,
          final_due: { $lt: cel`isoDate(today())` },
        },
        limit: 500,
        outputVariable: 'finalList',
      },
    },
    eachIssue(
      'final',
      cel`finalList`,
      '整改单 {{ issue.issue_no }} 最终回复已逾期',
      '根因与永久措施（D4–D7）期限 {{ issue.final_due }} 已过，整改单仍未进入效果验证。请督促供应商并跟进审核。',
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_quality_managers', type: 'default' },
    { id: 'e2', source: 'load_quality_managers', target: 'find_containment', type: 'default' },
    { id: 'e3', source: 'find_containment', target: 'each_containment', type: 'default' },
    { id: 'e4', source: 'each_containment', target: 'find_final', type: 'default' },
    { id: 'e5', source: 'find_final', target: 'each_final', type: 'default' },
    { id: 'e6', source: 'each_final', target: 'end', type: 'default' },
  ],
};
