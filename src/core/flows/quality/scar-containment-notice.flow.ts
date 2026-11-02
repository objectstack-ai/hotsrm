import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 供应商在门户提交临时措施（D3）时通知负责 SQE 查看（03 §8 第 2 步，v0.6 U5）；整改单没有 SQE 时通知质量经理指派。
// 提交人（这次更新的 updated_by）就是负责 SQE 本人时不发：没开通门户的供应商由 SQE 代填。以系统身份运行的 flow 里
// current_user 为空，所以按记录上的 updated_by 判断。D4–D7 的提交由 srm_scar_review 发起审核，审批本身通知审核人。
export const ScarContainmentNoticeFlow: Automation.Flow = {
  name: 'srm_scar_containment_notice',
  label: '供应商已提交临时措施',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '门户提交临时措施',
      config: {
        objectName: 'srm_quality_issue',
        triggerType: 'record-after-update',
        condition: P`record.status == 'containment_submitted' && has(previous.status) && previous.status == 'open' && !(has(record.sqe) && record.sqe != null && has(record.updated_by) && record.updated_by == record.sqe)`,
      },
    },
    {
      id: 'load_quality_managers',
      type: 'get_record',
      label: '读取质量经理',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_sqe',
              type: 'notify',
              label: '通知 SQE（没有 SQE 时通知质量经理）',
              config: {
                recipients: cel`has(record.sqe) && record.sqe != null ? [record.sqe] : qualityManagers.map(p, p.user_id)`,
                title: '整改单 {{ record.issue_no }}：供应商已提交临时措施',
                message: '供应商已在门户提交临时措施（D3），请查看。措施不够时把状态改回「待供应商响应」并写明审核意见。',
                sourceObject: 'srm_quality_issue',
                sourceId: cel`record.id`,
              },
            },
          ],
        },
        // 没有可通知的人时不影响提交
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_quality_managers', type: 'default' },
    { id: 'e2', source: 'load_quality_managers', target: 'notify_guard', type: 'default' },
    { id: 'e3', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
