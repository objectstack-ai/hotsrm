import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 供应商处置审批（03 §5、§12，FR-208，BR-11）：持 srm_supplier_admin 的岗位新建处置单即发起审批。
// 第 1 级品类经理：发起人是品类经理时发起即是这一级；不是（如采购主管）时先由品类经理审批。
// 冻结 / 解冻：再经采购总监；淘汰 / 黑名单 / 解除黑名单：再加总经理；拉入黑名单最后由内控会签。
// 第一个审批节点可以通过、驳回或退回修改；后面几级只能通过或驳回（见下）。全部通过后经 srm_disposition_apply
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
    filter: { request_id: cel$(`${node}.requestId`), action },
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

// 记下这一级的审批人：写到处置单上，同时留在变量里给后面几级比对
const recordApprover = (id: string, label: string, field: string, actor: string, variable: string) => [
  {
    id,
    type: 'update_record' as const,
    label,
    config: {
      objectName: 'srm_supplier_disposition',
      filter: { id: cel`record.id` },
      fields: { [field]: cel$(`${actor}.actor_id`) },
    },
  },
  { id: `${id}_var`, type: 'assignment' as const, label: `${label}（变量）`, config: { assignments: { [variable]: cel$(`${actor}.actor_id`) } } },
];

// 审批人撞人：发起人或前面各级的审批人（没经过的级别变量是空串，不会撞上）
const collides = (actor: string, earlier: string[]) =>
  [`${actor}.actor_id == record.created_by`, ...earlier.map((v) => `${actor}.actor_id == ${v}`)].join(' || ');
const sodEdges = (prefix: string, decision: string, actor: string, earlier: string[], selfNode: string, okNode: string, review: string) => [
  { id: `e_${prefix}_self`, source: decision, target: selfNode, type: 'conditional' as const, condition: cel$(collides(actor, earlier)), label: '撞人' },
  { id: `e_${prefix}_ok`, source: decision, target: okNode, type: 'conditional' as const, condition: cel$(`!(${collides(actor, earlier)})`), label: '不同的人' },
  { id: `e_${prefix}_again`, source: selfNode, target: review, type: 'back' as const, label: '重新审批' },
];

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
    { id: 'init', type: 'assignment', label: '初始化审批人变量', config: { assignments: { categoryActor: '', directorActor: '', gmActor: '' } } },
    {
      id: 'load_initiator_cm',
      type: 'get_record',
      label: '发起人是品类经理？',
      config: {
        objectName: 'sys_user_position',
        filter: { user_id: cel`record.created_by`, position: 'srm_category_manager' },
        outputVariable: 'initiatorCm',
      },
    },
    { id: 'route_category', type: 'decision', label: '品类经理一级是否已由发起完成？' },

    // 1. 品类经理（发起人不是品类经理时）。可以通过、驳回或退回修改，退回后发起人改完重新提交、从品类经理重新审批
    { id: 'category_review', ...approval('品类经理审批', 'srm_category_manager', 3) },
    actionOf('category_action', '读取品类经理审批记录', 'category_review', 'approve', 'categoryAction'),
    { id: 'category_sod', type: 'decision', label: '品类经理是发起人？' },
    self(
      'category_self',
      '发起人不能审批本人的处置单',
      'categoryAction',
      '处置单 {{ record.disposition_no }} 需由另一位品类经理审批',
      '你是这张处置单的发起人，你的通过不计入审批，已重新提交给品类经理。',
    ),
    ...recordApprover('record_category', '记录品类经理审批人', 'category_approver', 'categoryAction', 'categoryActor'),

    // 2. 采购总监。发起人是品类经理时这是第一个审批节点，可以退回修改（director_review）；先经品类经理审批时
    // 它是第 2 个审批节点，只能通过或驳回（director_review_after_category）。
    // 临时做法：第 2 个起的审批节点只能通过或驳回、不能退回修改——平台把第 2 个审批节点的提交人记成恢复流程的人
    // （上一级审批人），退回后发起人无法重新提交（objectstack#24817 已在主干修复、18.0.0 未带上）。
    // 平台修复后合并两个采购总监节点，并给后面几级加回 revise 边，退回到发起人
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
    { id: 'director_review_after_category', ...approval('采购总监审批', 'srm_procurement_director', 0) },
    actionOf('director_action_after_category', '读取采购总监审批记录', 'director_review_after_category', 'approve', 'directorAction'),
    { id: 'director_sod_after_category', type: 'decision', label: '采购总监与发起人、品类经理不同？' },
    self(
      'director_self_after_category',
      '各级审批人不能是同一人',
      'directorAction',
      '处置单 {{ record.disposition_no }} 需由另一位采购总监审批',
      '处置单的发起人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给采购总监。',
    ),
    ...recordApprover('record_director', '记录采购总监审批人', 'director_approver', 'directorAction', 'directorActor'),
    { id: 'needs_gm', type: 'decision', label: '淘汰、黑名单或解除黑名单？' },

    // 3. 总经理（淘汰 / 黑名单 / 解除黑名单）
    { id: 'gm_review', ...approval('总经理审批', 'srm_general_manager', 0) },
    actionOf('gm_action', '读取总经理审批记录', 'gm_review', 'approve', 'gmAction'),
    { id: 'gm_sod', type: 'decision', label: '总经理与发起人、前几级不同？' },
    self(
      'gm_self',
      '各级审批人不能是同一人',
      'gmAction',
      '处置单 {{ record.disposition_no }} 需由另一位总经理审批',
      '处置单的发起人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给总经理。',
    ),
    ...recordApprover('record_gm', '记录总经理审批人', 'gm_approver', 'gmAction', 'gmActor'),
    { id: 'needs_compliance', type: 'decision', label: '拉入黑名单？' },

    // 4. 内控会签（拉入黑名单）
    { id: 'compliance_review', ...approval('内控会签', 'srm_procurement_compliance', 0) },
    actionOf('compliance_action', '读取内控会签记录', 'compliance_review', 'approve', 'complianceAction'),
    { id: 'compliance_sod', type: 'decision', label: '会签人与发起人、前几级审批人不同？' },
    self(
      'compliance_self',
      '各级审批人不能是同一人',
      'complianceAction',
      '处置单 {{ record.disposition_no }} 需由另一位内控人员会签',
      '处置单的发起人和各级审批人不能是同一人（BR-11），你的会签不计入审批，已重新提交给内控。',
    ),
    {
      id: 'record_compliance',
      type: 'update_record',
      label: '记录内控会签人',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`record.id` },
        fields: { compliance_approver: cel`complianceAction.actor_id` },
      },
    },

    // 5. 通过：执行处置
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

    // 6. 驳回：不改供应商，记下驳回意见
    actionOf('category_reject_action', '读取品类经理驳回意见', 'category_review', 'reject', 'rejectAction'),
    actionOf('director_reject_action', '读取采购总监驳回意见', 'director_review', 'reject', 'rejectAction'),
    actionOf('director_reject_action_after_category', '读取采购总监驳回意见', 'director_review_after_category', 'reject', 'rejectAction'),
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

    // 7. 退回修改：记录解锁，发起人改完后重新提交，从退回的那一级重新审批
    { id: 'category_revise_window', type: 'approval_revise', label: '退回修改' },
    { id: 'revise_window', type: 'approval_revise', label: '退回修改' },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e_start', source: 'start', target: 'init', type: 'default' },
    { id: 'e_init', source: 'init', target: 'load_initiator_cm', type: 'default' },
    { id: 'e_route', source: 'load_initiator_cm', target: 'route_category', type: 'default' },
    {
      id: 'e_route_cm',
      source: 'route_category',
      target: 'category_review',
      type: 'conditional',
      condition: P`initiatorCm == null`,
      label: '发起人不是品类经理：先经品类经理',
    },
    {
      id: 'e_route_director',
      source: 'route_category',
      target: 'director_review',
      type: 'conditional',
      condition: P`initiatorCm != null`,
      label: '品类经理发起：直接到采购总监',
    },

    { id: 'e_c_approve', source: 'category_review', target: 'category_action', type: 'default', label: 'approve' },
    { id: 'e_c_reject', source: 'category_review', target: 'category_reject_action', type: 'default', label: 'reject' },
    { id: 'e_c_revise', source: 'category_review', target: 'category_revise_window', type: 'default', label: 'revise' },
    { id: 'e_c_sod', source: 'category_action', target: 'category_sod', type: 'default' },
    ...sodEdges('c', 'category_sod', 'categoryAction', [], 'category_self', 'record_category', 'category_review'),
    { id: 'e_c_var', source: 'record_category', target: 'record_category_var', type: 'default' },
    { id: 'e_c_next', source: 'record_category_var', target: 'director_review_after_category', type: 'default' },

    { id: 'e_d_approve', source: 'director_review', target: 'director_action', type: 'default', label: 'approve' },
    { id: 'e_d_reject', source: 'director_review', target: 'director_reject_action', type: 'default', label: 'reject' },
    { id: 'e_d_revise', source: 'director_review', target: 'revise_window', type: 'default', label: 'revise' },
    { id: 'e_d_sod', source: 'director_action', target: 'director_sod', type: 'default' },
    ...sodEdges('d', 'director_sod', 'directorAction', [], 'director_self', 'record_director', 'director_review'),

    { id: 'e_dc_approve', source: 'director_review_after_category', target: 'director_action_after_category', type: 'default', label: 'approve' },
    { id: 'e_dc_reject', source: 'director_review_after_category', target: 'director_reject_action_after_category', type: 'default', label: 'reject' },
    { id: 'e_dc_sod', source: 'director_action_after_category', target: 'director_sod_after_category', type: 'default' },
    ...sodEdges(
      'dc',
      'director_sod_after_category',
      'directorAction',
      ['categoryActor'],
      'director_self_after_category',
      'record_director',
      'director_review_after_category',
    ),

    { id: 'e_d_var', source: 'record_director', target: 'record_director_var', type: 'default' },
    { id: 'e_d_next', source: 'record_director_var', target: 'needs_gm', type: 'default' },
    { id: 'e_gm', source: 'needs_gm', target: 'gm_review', type: 'conditional', condition: cel$(needsGm), label: '需总经理审批' },
    { id: 'e_no_gm', source: 'needs_gm', target: 'apply', type: 'conditional', condition: cel$(`!(${needsGm})`), label: '冻结 / 解冻' },

    { id: 'e_g_approve', source: 'gm_review', target: 'gm_action', type: 'default', label: 'approve' },
    { id: 'e_g_reject', source: 'gm_review', target: 'gm_reject_action', type: 'default', label: 'reject' },
    { id: 'e_g_sod', source: 'gm_action', target: 'gm_sod', type: 'default' },
    ...sodEdges('g', 'gm_sod', 'gmAction', ['categoryActor', 'directorActor'], 'gm_self', 'record_gm', 'gm_review'),
    { id: 'e_g_var', source: 'record_gm', target: 'record_gm_var', type: 'default' },
    { id: 'e_g_next', source: 'record_gm_var', target: 'needs_compliance', type: 'default' },
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

    { id: 'e_k_approve', source: 'compliance_review', target: 'compliance_action', type: 'default', label: 'approve' },
    { id: 'e_k_reject', source: 'compliance_review', target: 'compliance_reject_action', type: 'default', label: 'reject' },
    { id: 'e_k_sod', source: 'compliance_action', target: 'compliance_sod', type: 'default' },
    ...sodEdges(
      'k',
      'compliance_sod',
      'complianceAction',
      ['categoryActor', 'directorActor', 'gmActor'],
      'compliance_self',
      'record_compliance',
      'compliance_review',
    ),
    { id: 'e_k_next', source: 'record_compliance', target: 'apply', type: 'default' },

    { id: 'e_applied', source: 'apply', target: 'notify_applied', type: 'default' },
    { id: 'e_applied_end', source: 'notify_applied', target: 'end', type: 'default' },

    { id: 'e_c_rejected', source: 'category_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_d_rejected', source: 'director_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_dc_rejected', source: 'director_reject_action_after_category', target: 'mark_rejected', type: 'default' },
    { id: 'e_g_rejected', source: 'gm_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_k_rejected', source: 'compliance_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_rejected', source: 'mark_rejected', target: 'notify_rejected', type: 'default' },
    { id: 'e_rejected_end', source: 'notify_rejected', target: 'end', type: 'default' },

    { id: 'e_c_resubmit', source: 'category_revise_window', target: 'category_review', type: 'back', label: 'resubmit' },
    { id: 'e_resubmit', source: 'revise_window', target: 'director_review', type: 'back', label: 'resubmit' },
  ],
};
