import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P7 步骤 3–4（03 §8，FR-604）：整改单进入「已提交根因与措施」时由负责 SQE 审核（approval 节点，field = sqe；
// 没填 SQE 时交给质量经理）。通过 → 效果验证；退回 → 回到「已提交临时措施」，审批意见写入 sqe_comment，
// 改好 D4–D7 后再次提交会重新发起审核。
// 退回用审批的「驳回」：平台的「退回修改」窗口（approval_revise）只能原样回到审批节点，中间改不了状态，
// 而 02 §5.6 的退回要把状态改回上一步。退回必须写意见：驳回时没写意见的，这次驳回不算数，提醒 SQE 后重新审核。
const notify = (id: string, label: string, title: string, message: string): Automation.FlowNode => ({
  id,
  type: 'try_catch',
  label,
  config: {
    try: {
      nodes: [
        {
          id: `${id}_send`,
          type: 'notify',
          label,
          config: {
            recipients: cel`has(record.sqe) && record.sqe != null ? record.sqe : null`,
            title,
            message,
            sourceObject: 'srm_quality_issue',
            sourceId: cel`record.id`,
          },
        },
      ],
    },
    // 没有负责 SQE 时不通知，不影响状态推进
    catch: { nodes: [{ id: `${id}_skip`, type: 'assignment', label: '跳过通知' }] },
  },
});

export const ScarReviewFlow: Automation.Flow = {
  name: 'srm_scar_review',
  label: '整改措施审核',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '已提交根因与措施',
      config: {
        objectName: 'srm_quality_issue',
        triggerType: 'record-after-update',
        condition: P`record.status == 'action_submitted' && has(previous.status) && previous.status != 'action_submitted'`,
      },
    },
    {
      id: 'sqe_review',
      type: 'approval',
      label: 'SQE 审核整改措施',
      config: {
        approvers: [{ type: 'field', value: 'sqe' }],
        onEmptyApprovers: 'fallback',
        fallbackApprovers: [{ type: 'position', value: 'srm_quality_manager' }],
        behavior: 'first_response',
        lockRecord: true,
      },
    },
    {
      id: 'mark_verifying',
      type: 'update_record',
      label: '进入效果验证',
      config: { objectName: 'srm_quality_issue', filter: { id: cel`record.id` }, fields: { status: 'verifying' } },
    },
    {
      id: 'return_action',
      type: 'get_record',
      label: '读取退回意见',
      config: {
        objectName: 'sys_approval_action',
        filter: { request_id: cel`sqe_review.requestId`, action: 'reject' },
        outputVariable: 'returnAction',
      },
    },
    { id: 'has_comment', type: 'decision', label: '写了退回意见？' },
    {
      id: 'comment_missing',
      type: 'notify',
      label: '退回须写意见',
      config: {
        recipients: cel`returnAction.actor_id`,
        title: '整改单 {{ record.issue_no }} 退回时请填写意见',
        message: '退回整改单必须写明退回意见（FR-604），这次退回未生效，已重新提交审核。请在审核意见里写明需要供应商补充或修改的内容后再退回。',
        severity: 'warning',
        sourceObject: 'srm_quality_issue',
        sourceId: cel`record.id`,
      },
    },
    {
      id: 'mark_returned',
      type: 'update_record',
      label: '退回到已提交临时措施',
      config: {
        objectName: 'srm_quality_issue',
        filter: { id: cel`record.id` },
        fields: { status: 'containment_submitted', sqe_comment: cel`returnAction.comment` },
      },
    },
    notify(
      'notify_returned',
      '通知 SQE：整改已退回',
      '整改单 {{ record.issue_no }} 已退回',
      '根因与措施（D4–D7）已退回，退回意见见整改单。请转告供应商修改后重新提交。',
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'sqe_review', type: 'default' },
    { id: 'e_approve', source: 'sqe_review', target: 'mark_verifying', type: 'default', label: 'approve' },
    { id: 'e_reject', source: 'sqe_review', target: 'return_action', type: 'default', label: 'reject' },
    { id: 'e_verifying', source: 'mark_verifying', target: 'end', type: 'default' },
    { id: 'e_check', source: 'return_action', target: 'has_comment', type: 'default' },
    {
      id: 'e_no_comment',
      source: 'has_comment',
      target: 'comment_missing',
      type: 'conditional',
      condition: P`returnAction == null || !has(returnAction.comment) || returnAction.comment == null || isBlank(trim(returnAction.comment))`,
      label: '没写',
    },
    {
      id: 'e_comment',
      source: 'has_comment',
      target: 'mark_returned',
      type: 'conditional',
      condition: P`returnAction != null && has(returnAction.comment) && returnAction.comment != null && !isBlank(trim(returnAction.comment))`,
      label: '写了',
    },
    { id: 'e_again', source: 'comment_missing', target: 'sqe_review', type: 'back', label: '重新审核' },
    { id: 'e_returned', source: 'mark_returned', target: 'notify_returned', type: 'default' },
    { id: 'e_end', source: 'notify_returned', target: 'end', type: 'default' },
  ],
};
