import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 供应商处置审批（03 §5、§12，FR-208，BR-11）：品类经理新建处置单即发起审批，发起即是品类经理一级。
// 冻结 / 解冻：采购总监；淘汰 / 黑名单 / 解除黑名单：再加总经理；拉入黑名单最后由内控会签。
// 采购总监可以通过、驳回或退回修改；后面几级只能通过或驳回（见下）。全部通过后经 srm_disposition_apply
// 执行；驳回不改供应商，把驳回意见写进 reject_reason 并通知发起人。
//
// 职责分离：发起人不能审批本人的处置单，各级审批人不能是同一人。平台审批服务还没有「提交人不得
// 审批本人单据」的开关（objectstack#25446），岗位又可能兼任，所以每级通过后由 flow 读审批记录比对：
// 撞人时这次通过不算数，通知审批人后重新开一轮同级审批（临时做法，平台支持后改为节点配置）。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });

const approval = (label: string, position: string, maxRevisions: number) => ({
  type: 'approval' as const,
  label,
  config: {
    approvers: [{ type: 'position' as const, value: position }],
    // 岗位没人时交给组织管理员，避免处置单卡在锁定状态
    onEmptyApprovers: 'admin_rescue' as const,
    behavior: 'first_response' as const,
    lockRecord: true,
    approvalStatusField: 'approval_status',
    maxRevisions,
  },
});

// 读某次审批的通过 / 驳回记录：actor_id 是审批人，comment 是审批意见
const actionOf = (id: string, label: string, node: string, action: string, outputVariable: string) => ({
  id,
  type: 'get_record' as const,
  label,
  config: {
    objectName: 'sys_approval_action',
    filter: { request_id: { dialect: 'cel' as const, source: `${node}.requestId` }, action },
    outputVariable,
  },
});

const self = (id: string, label: string, actor: string, title: string, message: string) => ({
  id,
  type: 'notify' as const,
  label,
  config: {
    recipients: cel$(`${actor}.actor_id`),
    title,
    message,
    severity: 'warning' as const,
    sourceObject: 'srm_supplier_disposition',
    sourceId: cel`record.id`,
  },
});

const recordApprover = (id: string, label: string, field: string, actor: string) => ({
  id,
  type: 'update_record' as const,
  label,
  config: {
    objectName: 'srm_supplier_disposition',
    filter: { id: cel`record.id` },
    fields: { [field]: cel$(`${actor}.actor_id`) },
  },
});

// 需要总经理审批的动作
const needsGm = `record.action == 'eliminate' || record.action == 'blacklist' || record.action == 'remove_blacklist'`;

export const DispositionApprovalFlow: Automation.Flow = {
  name: 'srm_disposition_approval',
  label: '供应商处置审批',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建处置单',
      config: {
        objectName: 'srm_supplier_disposition',
        triggerType: 'record-after-create',
        condition: P`record.status == 'in_review'`,
      },
    },

    // 1. 采购总监
    { id: 'director_review', ...approval('采购总监审批', 'srm_procurement_director', 3) },
    actionOf('director_action', '读取采购总监审批记录', 'director_review', 'approve', 'directorAction'),
    { id: 'director_sod', type: 'decision', label: '采购总监是发起人？' },
    self(
      'director_self',
      '发起人不能审批本人的处置单',
      'directorAction',
      '处置单 {{ record.disposition_no }} 需由另一位采购总监审批',
      '你是这张处置单的发起人，你的通过不计入审批，已重新提交给采购总监。',
    ),
    recordApprover('record_director', '记录采购总监审批人', 'director_approver', 'directorAction'),
    { id: 'needs_gm', type: 'decision', label: '淘汰、黑名单或解除黑名单？' },

    // 2. 总经理（淘汰 / 黑名单 / 解除黑名单）。临时做法：这一级和内控会签只能通过或驳回、不能退回修改——
    // 平台把第 2 个审批节点的提交人记成恢复流程的人（上一级审批人），退回后发起人无法重新提交
    // （objectstack#24817 已在主干修复、18.0.0 未带上）。平台修复后加回 revise 边，退回到发起人
    { id: 'gm_review', ...approval('总经理审批', 'srm_general_manager', 0) },
    actionOf('gm_action', '读取总经理审批记录', 'gm_review', 'approve', 'gmAction'),
    { id: 'gm_sod', type: 'decision', label: '总经理与发起人、采购总监不同？' },
    self(
      'gm_self',
      '各级审批人不能是同一人',
      'gmAction',
      '处置单 {{ record.disposition_no }} 需由另一位总经理审批',
      '处置单的发起人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给总经理。',
    ),
    recordApprover('record_gm', '记录总经理审批人', 'gm_approver', 'gmAction'),
    { id: 'needs_compliance', type: 'decision', label: '拉入黑名单？' },

    // 3. 内控会签（拉入黑名单）
    { id: 'compliance_review', ...approval('内控会签', 'srm_procurement_compliance', 0) },
    actionOf('compliance_action', '读取内控会签记录', 'compliance_review', 'approve', 'complianceAction'),
    { id: 'compliance_sod', type: 'decision', label: '会签人与发起人、前两级审批人不同？' },
    self(
      'compliance_self',
      '各级审批人不能是同一人',
      'complianceAction',
      '处置单 {{ record.disposition_no }} 需由另一位内控人员会签',
      '处置单的发起人和各级审批人不能是同一人（BR-11），你的会签不计入审批，已重新提交给内控。',
    ),
    recordApprover('record_compliance', '记录内控会签人', 'compliance_approver', 'complianceAction'),

    // 4. 通过：执行处置
    {
      id: 'apply',
      type: 'subflow',
      label: '执行处置',
      config: { flowName: 'srm_disposition_apply', input: { recordId: cel`record.id` } },
    },
    {
      id: 'notify_applied',
      type: 'notify',
      label: '通知发起人：已执行',
      config: {
        recipients: cel`record.created_by`,
        title: '处置单 {{ record.disposition_no }} 已审批通过并执行',
        message: '供应商状态和品类资格已按处置单更新。请通知采购员在 ERP 同步供应商的冻结标志。',
        sourceObject: 'srm_supplier_disposition',
        sourceId: cel`record.id`,
      },
    },

    // 5. 驳回：不改供应商，记下驳回意见
    actionOf('director_reject_action', '读取采购总监驳回意见', 'director_review', 'reject', 'rejectAction'),
    actionOf('gm_reject_action', '读取总经理驳回意见', 'gm_review', 'reject', 'rejectAction'),
    actionOf('compliance_reject_action', '读取内控驳回意见', 'compliance_review', 'reject', 'rejectAction'),
    {
      id: 'mark_rejected',
      type: 'update_record',
      label: '处置单已驳回',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`record.id` },
        fields: {
          status: 'rejected',
          reject_reason: cel`rejectAction != null && has(rejectAction.comment) ? rejectAction.comment : null`,
        },
      },
    },
    {
      id: 'notify_rejected',
      type: 'notify',
      label: '通知发起人：已驳回',
      config: {
        recipients: cel`record.created_by`,
        title: '处置单 {{ record.disposition_no }} 已驳回',
        message: '供应商状态未作修改，驳回原因见处置单。',
        severity: 'warning',
        sourceObject: 'srm_supplier_disposition',
        sourceId: cel`record.id`,
      },
    },

    // 6. 退回修改：记录解锁，发起人改完后重新提交，从采购总监重新审批
    { id: 'revise_window', type: 'approval_revise', label: '退回修改' },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e_start', source: 'start', target: 'director_review', type: 'default' },

    { id: 'e_d_approve', source: 'director_review', target: 'director_action', type: 'default', label: 'approve' },
    { id: 'e_d_reject', source: 'director_review', target: 'director_reject_action', type: 'default', label: 'reject' },
    { id: 'e_d_revise', source: 'director_review', target: 'revise_window', type: 'default', label: 'revise' },
    { id: 'e_d_sod', source: 'director_action', target: 'director_sod', type: 'default' },
    {
      id: 'e_d_self',
      source: 'director_sod',
      target: 'director_self',
      type: 'conditional',
      condition: P`directorAction.actor_id == record.created_by`,
      label: '是发起人',
    },
    {
      id: 'e_d_ok',
      source: 'director_sod',
      target: 'record_director',
      type: 'conditional',
      condition: P`directorAction.actor_id != record.created_by`,
      label: '不是发起人',
    },
    { id: 'e_d_again', source: 'director_self', target: 'director_review', type: 'back', label: '重新审批' },
    { id: 'e_d_next', source: 'record_director', target: 'needs_gm', type: 'default' },
    { id: 'e_gm', source: 'needs_gm', target: 'gm_review', type: 'conditional', condition: cel$(needsGm), label: '需总经理审批' },
    { id: 'e_no_gm', source: 'needs_gm', target: 'apply', type: 'conditional', condition: cel$(`!(${needsGm})`), label: '冻结 / 解冻' },

    { id: 'e_g_approve', source: 'gm_review', target: 'gm_action', type: 'default', label: 'approve' },
    { id: 'e_g_reject', source: 'gm_review', target: 'gm_reject_action', type: 'default', label: 'reject' },
    { id: 'e_g_sod', source: 'gm_action', target: 'gm_sod', type: 'default' },
    {
      id: 'e_g_self',
      source: 'gm_sod',
      target: 'gm_self',
      type: 'conditional',
      condition: P`gmAction.actor_id == record.created_by || gmAction.actor_id == directorAction.actor_id`,
      label: '撞人',
    },
    {
      id: 'e_g_ok',
      source: 'gm_sod',
      target: 'record_gm',
      type: 'conditional',
      condition: P`gmAction.actor_id != record.created_by && gmAction.actor_id != directorAction.actor_id`,
      label: '不同的人',
    },
    { id: 'e_g_again', source: 'gm_self', target: 'gm_review', type: 'back', label: '重新审批' },
    { id: 'e_g_next', source: 'record_gm', target: 'needs_compliance', type: 'default' },
    {
      id: 'e_compliance',
      source: 'needs_compliance',
      target: 'compliance_review',
      type: 'conditional',
      condition: P`record.action == 'blacklist'`,
      label: '拉入黑名单',
    },
    {
      id: 'e_no_compliance',
      source: 'needs_compliance',
      target: 'apply',
      type: 'conditional',
      condition: P`record.action != 'blacklist'`,
      label: '淘汰 / 解除黑名单',
    },

    { id: 'e_c_approve', source: 'compliance_review', target: 'compliance_action', type: 'default', label: 'approve' },
    { id: 'e_c_reject', source: 'compliance_review', target: 'compliance_reject_action', type: 'default', label: 'reject' },
    { id: 'e_c_sod', source: 'compliance_action', target: 'compliance_sod', type: 'default' },
    {
      id: 'e_c_self',
      source: 'compliance_sod',
      target: 'compliance_self',
      type: 'conditional',
      condition: P`complianceAction.actor_id == record.created_by || complianceAction.actor_id == directorAction.actor_id || complianceAction.actor_id == gmAction.actor_id`,
      label: '撞人',
    },
    {
      id: 'e_c_ok',
      source: 'compliance_sod',
      target: 'record_compliance',
      type: 'conditional',
      condition: P`complianceAction.actor_id != record.created_by && complianceAction.actor_id != directorAction.actor_id && complianceAction.actor_id != gmAction.actor_id`,
      label: '不同的人',
    },
    { id: 'e_c_again', source: 'compliance_self', target: 'compliance_review', type: 'back', label: '重新会签' },
    { id: 'e_c_next', source: 'record_compliance', target: 'apply', type: 'default' },

    { id: 'e_applied', source: 'apply', target: 'notify_applied', type: 'default' },
    { id: 'e_applied_end', source: 'notify_applied', target: 'end', type: 'default' },

    { id: 'e_d_rejected', source: 'director_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_g_rejected', source: 'gm_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_c_rejected', source: 'compliance_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_rejected', source: 'mark_rejected', target: 'notify_rejected', type: 'default' },
    { id: 'e_rejected_end', source: 'notify_rejected', target: 'end', type: 'default' },

    { id: 'e_resubmit', source: 'revise_window', target: 'director_review', type: 'back', label: 'resubmit' },
  ],
};
