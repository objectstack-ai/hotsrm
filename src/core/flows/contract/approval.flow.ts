import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 合同审批（03 §6 第 2 步、§12 合同行，BR-11）：srm_contract_submit 把合同置为「审批中」即发起。
// 第 1 级法务（合同上的 legal_reviewer；没填时交给法务岗位），之后按合同金额（框架协议为年度预计金额）
// 执行与定标同档的审批：不足 mid 档品类经理；mid 档至不足 high 档品类经理 → 采购总监；high 档及以上再加总经理。
// 通过 → 签署中；驳回 → 审批未通过，驳回意见写进 reject_reason；提交人撤回 → 回到草稿（srm_contract_recalled）。
//
// 金额档取 params/core.yaml 的 award_approval_tiers（示例 10 万 / 100 万，参数单位是万元），客户改参数时同步这里。
// 金额按数值比较、不换算币种。
const MID = 100_000;
const HIGH = 1_000_000;
const amount = `(has(record.amount) && record.amount != null ? double(record.amount) : 0.0)`;
const atLeast = (tier: number) => ({ dialect: 'cel' as const, source: `${amount} >= ${tier}.0` });
const below = (tier: number) => ({ dialect: 'cel' as const, source: `${amount} < ${tier}.0` });

// 职责分离：起草人和提交人不能审批本合同，各级审批人不能是同一人。平台审批服务还没有「提交人不得
// 审批本人单据」的开关（objectstack#25446），岗位又可能兼任，所以每级通过后由 flow 读审批记录比对：
// 撞人时这次通过不算数，通知审批人后重新开一轮同级审批（临时做法，同变更单、处置单）。
// 起草人或提交人本身是品类经理时，品类经理一级改由上一级（采购总监）审批（03 §12、GL-03 附录 A）。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
const initiators = `[record.created_by, record.submitted_by]`;
// 查岗位用：系统生成的续签草稿没有起草人，列表里不能有 null
const initiatorIds = `has(record.created_by) && record.created_by != null ? [record.created_by, record.submitted_by] : [record.submitted_by]`;

const approval = (label: string, approvers: Automation.ApprovalNodeApprover[], maxRevisions: number, extra: Record<string, unknown> = {}) => ({
  type: 'approval' as const,
  label,
  config: {
    approvers,
    // 岗位没人时交给组织管理员，避免合同卡在锁定状态
    onEmptyApprovers: 'admin_rescue' as const,
    behavior: 'first_response' as const,
    lockRecord: true,
    approvalStatusField: 'approval_status',
    maxRevisions,
    ...extra,
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
    sourceObject: 'srm_contract',
    sourceId: cel`record.id`,
  },
});

// 记下这一级的审批人：写到合同上，同时留在变量里给后面几级比对
const recordApprover = (id: string, label: string, field: string, actor: string, variable: string) => [
  {
    id,
    type: 'update_record' as const,
    label,
    config: { objectName: 'srm_contract', filter: { id: cel`record.id` }, fields: { [field]: cel$(`${actor}.actor_id`) } },
  },
  { id: `${id}_var`, type: 'assignment' as const, label: `${label}（变量）`, config: { assignments: { [variable]: cel$(`${actor}.actor_id`) } } },
];

// 审批人撞人：起草人、提交人或前面各级的审批人
const collides = (actor: string, earlier: string[]) =>
  [`${actor}.actor_id in ${initiators}`, ...earlier.map((v) => `${actor}.actor_id == ${v}`)].join(' || ');
const sodEdges = (prefix: string, decision: string, actor: string, earlier: string[], selfNode: string, okNode: string, review: string) => [
  { id: `e_${prefix}_self`, source: decision, target: selfNode, type: 'conditional' as const, condition: cel$(collides(actor, earlier)), label: '撞人' },
  { id: `e_${prefix}_ok`, source: decision, target: okNode, type: 'conditional' as const, condition: cel$(`!(${collides(actor, earlier)})`), label: '不同的人' },
  { id: `e_${prefix}_again`, source: selfNode, target: review, type: 'back' as const, label: '重新审批' },
];

export const ContractApprovalFlow: Automation.Flow = {
  name: 'srm_contract_approval',
  label: '合同审批',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '合同提交审批',
      config: {
        objectName: 'srm_contract',
        triggerType: 'record-after-update',
        condition: P`record.status == 'in_review' && has(previous.status) && previous.status != 'in_review'`,
      },
    },
    { id: 'init', type: 'assignment', label: '初始化审批人变量', config: { assignments: { legalActor: '', categoryActor: '', directorActor: '' } } },

    // 1. 法务。可以通过、驳回或退回修改，退回后提交人改完重新提交、从法务重新审批
    {
      id: 'legal_review',
      ...approval('法务审核', [{ type: 'field', value: 'legal_reviewer' }], 3, {
        onEmptyApprovers: 'fallback',
        fallbackApprovers: [{ type: 'position', value: 'srm_legal_counsel' }],
      }),
    },
    actionOf('legal_action', '读取法务审批记录', 'legal_review', 'approve', 'legalAction'),
    { id: 'legal_sod', type: 'decision', label: '法务是起草人或提交人？' },
    self(
      'legal_self',
      '起草人、提交人不能审批本合同',
      'legalAction',
      '合同 {{ record.contract_no }} 需由另一位法务审核',
      '你是这份合同的起草人或提交人，你的通过不计入审批，已重新提交给法务。',
    ),
    ...recordApprover('record_legal', '记录法务审批人', 'legal_approver', 'legalAction', 'legalActor'),

    // 2. 品类经理；起草人或提交人是品类经理时改由采购总监审批
    {
      id: 'load_initiator_cm',
      type: 'get_record',
      label: '起草人或提交人是品类经理？',
      config: {
        objectName: 'sys_user_position',
        filter: { user_id: { $in: cel$(initiatorIds) }, position: 'srm_category_manager' },
        outputVariable: 'initiatorCm',
      },
    },
    { id: 'route_category', type: 'decision', label: '品类经理一级由谁审批？' },
    // 临时做法：法务之后的各级只能通过或驳回、不能退回修改——平台把第 2 个起的审批节点的提交人记成恢复流程的人
    // （上一级审批人），退回后提交人无法重新提交（objectstack#24817 已在主干修复、18.0.0 未带上）。
    // 平台修复后给这几级加回 revise 边，退回到提交人
    { id: 'category_review', ...approval('品类经理审批', [{ type: 'position', value: 'srm_category_manager' }], 0) },
    actionOf('category_action', '读取品类经理审批记录', 'category_review', 'approve', 'categoryAction'),
    { id: 'category_sod', type: 'decision', label: '品类经理与起草人、提交人、法务不同？' },
    self(
      'category_self',
      '各级审批人不能是同一人',
      'categoryAction',
      '合同 {{ record.contract_no }} 需由另一位品类经理审批',
      '合同的起草人、提交人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给品类经理。',
    ),
    ...recordApprover('record_category', '记录品类经理审批人', 'category_approver', 'categoryAction', 'categoryActor'),
    { id: 'needs_director', type: 'decision', label: '达到 mid 档？' },

    // 3. 采购总监（mid 档及以上，或替起草的品类经理审批）
    { id: 'director_review', ...approval('采购总监审批', [{ type: 'position', value: 'srm_procurement_director' }], 0) },
    actionOf('director_action', '读取采购总监审批记录', 'director_review', 'approve', 'directorAction'),
    { id: 'director_sod', type: 'decision', label: '采购总监与起草人、提交人、前几级不同？' },
    self(
      'director_self',
      '各级审批人不能是同一人',
      'directorAction',
      '合同 {{ record.contract_no }} 需由另一位采购总监审批',
      '合同的起草人、提交人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给采购总监。',
    ),
    ...recordApprover('record_director', '记录采购总监审批人', 'director_approver', 'directorAction', 'directorActor'),
    { id: 'needs_gm', type: 'decision', label: '达到 high 档？' },

    // 4. 总经理（high 档及以上）
    { id: 'gm_review', ...approval('总经理审批', [{ type: 'position', value: 'srm_general_manager' }], 0) },
    actionOf('gm_action', '读取总经理审批记录', 'gm_review', 'approve', 'gmAction'),
    { id: 'gm_sod', type: 'decision', label: '总经理与起草人、提交人、前几级不同？' },
    self(
      'gm_self',
      '各级审批人不能是同一人',
      'gmAction',
      '合同 {{ record.contract_no }} 需由另一位总经理审批',
      '合同的起草人、提交人和各级审批人不能是同一人（BR-11），你的通过不计入审批，已重新提交给总经理。',
    ),
    {
      id: 'record_gm',
      type: 'update_record',
      label: '记录总经理审批人',
      config: { objectName: 'srm_contract', filter: { id: cel`record.id` }, fields: { gm_approver: cel`gmAction.actor_id` } },
    },

    // 5. 通过：进入签署
    {
      id: 'mark_signing',
      type: 'update_record',
      label: '合同进入签署',
      config: { objectName: 'srm_contract', filter: { id: cel`record.id` }, fields: { status: 'signing' } },
    },
    {
      id: 'notify_signing',
      type: 'notify',
      label: '通知起草人：审批通过',
      config: {
        recipients: [cel`record.created_by`, cel`has(record.submitted_by) ? record.submitted_by : null`],
        title: '合同 {{ record.contract_no }} 已审批通过',
        message: '合同「{{ record.title }}」已进入签署。请组织双方签署，上传盖章件、填写签署日期后确认生效。',
        sourceObject: 'srm_contract',
        sourceId: cel`record.id`,
      },
    },

    // 6. 驳回或撤回：读驳回记录，读不到说明是提交人撤回（平台把撤回走驳回分支），回草稿由 srm_contract_recalled 负责
    actionOf('legal_reject_action', '读取法务驳回意见', 'legal_review', 'reject', 'rejectAction'),
    actionOf('category_reject_action', '读取品类经理驳回意见', 'category_review', 'reject', 'rejectAction'),
    actionOf('director_reject_action', '读取采购总监驳回意见', 'director_review', 'reject', 'rejectAction'),
    actionOf('gm_reject_action', '读取总经理驳回意见', 'gm_review', 'reject', 'rejectAction'),
    { id: 'rejected_or_recalled', type: 'decision', label: '驳回还是撤回？' },
    {
      id: 'mark_rejected',
      type: 'update_record',
      label: '合同审批未通过',
      config: {
        objectName: 'srm_contract',
        filter: { id: cel`record.id` },
        fields: { status: 'rejected', reject_reason: cel`has(rejectAction.comment) ? rejectAction.comment : null` },
      },
    },
    {
      id: 'notify_rejected',
      type: 'notify',
      label: '通知起草人：已驳回',
      config: {
        recipients: [cel`record.created_by`, cel`has(record.submitted_by) ? record.submitted_by : null`],
        title: '合同 {{ record.contract_no }} 审批未通过',
        message: '合同「{{ record.title }}」已被驳回，驳回原因见合同。需要继续合作的，请重新起草合同。',
        severity: 'warning',
        sourceObject: 'srm_contract',
        sourceId: cel`record.id`,
      },
    },

    // 7. 退回修改：记录解锁，提交人改完后重新提交，从法务重新审批
    { id: 'revise_window', type: 'approval_revise', label: '退回修改' },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e_start', source: 'start', target: 'init', type: 'default' },
    { id: 'e_init', source: 'init', target: 'legal_review', type: 'default' },

    { id: 'e_l_approve', source: 'legal_review', target: 'legal_action', type: 'default', label: 'approve' },
    { id: 'e_l_reject', source: 'legal_review', target: 'legal_reject_action', type: 'default', label: 'reject' },
    { id: 'e_l_revise', source: 'legal_review', target: 'revise_window', type: 'default', label: 'revise' },
    { id: 'e_l_sod', source: 'legal_action', target: 'legal_sod', type: 'default' },
    ...sodEdges('l', 'legal_sod', 'legalAction', [], 'legal_self', 'record_legal', 'legal_review'),
    { id: 'e_l_var', source: 'record_legal', target: 'record_legal_var', type: 'default' },
    { id: 'e_l_next', source: 'record_legal_var', target: 'load_initiator_cm', type: 'default' },
    { id: 'e_route', source: 'load_initiator_cm', target: 'route_category', type: 'default' },
    {
      id: 'e_route_cm',
      source: 'route_category',
      target: 'category_review',
      type: 'conditional',
      condition: P`initiatorCm == null`,
      label: '品类经理审批',
    },
    {
      id: 'e_route_director',
      source: 'route_category',
      target: 'director_review',
      type: 'conditional',
      condition: P`initiatorCm != null`,
      label: '起草人或提交人是品类经理：改由采购总监',
    },

    { id: 'e_c_approve', source: 'category_review', target: 'category_action', type: 'default', label: 'approve' },
    { id: 'e_c_reject', source: 'category_review', target: 'category_reject_action', type: 'default', label: 'reject' },
    { id: 'e_c_sod', source: 'category_action', target: 'category_sod', type: 'default' },
    ...sodEdges('c', 'category_sod', 'categoryAction', ['legalActor'], 'category_self', 'record_category', 'category_review'),
    { id: 'e_c_var', source: 'record_category', target: 'record_category_var', type: 'default' },
    { id: 'e_c_next', source: 'record_category_var', target: 'needs_director', type: 'default' },
    { id: 'e_director', source: 'needs_director', target: 'director_review', type: 'conditional', condition: atLeast(MID), label: 'mid 档及以上' },
    { id: 'e_no_director', source: 'needs_director', target: 'mark_signing', type: 'conditional', condition: below(MID), label: '不足 mid 档' },

    { id: 'e_d_approve', source: 'director_review', target: 'director_action', type: 'default', label: 'approve' },
    { id: 'e_d_reject', source: 'director_review', target: 'director_reject_action', type: 'default', label: 'reject' },
    { id: 'e_d_sod', source: 'director_action', target: 'director_sod', type: 'default' },
    ...sodEdges('d', 'director_sod', 'directorAction', ['legalActor', 'categoryActor'], 'director_self', 'record_director', 'director_review'),
    { id: 'e_d_var', source: 'record_director', target: 'record_director_var', type: 'default' },
    { id: 'e_d_next', source: 'record_director_var', target: 'needs_gm', type: 'default' },
    { id: 'e_gm', source: 'needs_gm', target: 'gm_review', type: 'conditional', condition: atLeast(HIGH), label: 'high 档及以上' },
    { id: 'e_no_gm', source: 'needs_gm', target: 'mark_signing', type: 'conditional', condition: below(HIGH), label: '不足 high 档' },

    { id: 'e_g_approve', source: 'gm_review', target: 'gm_action', type: 'default', label: 'approve' },
    { id: 'e_g_reject', source: 'gm_review', target: 'gm_reject_action', type: 'default', label: 'reject' },
    { id: 'e_g_sod', source: 'gm_action', target: 'gm_sod', type: 'default' },
    ...sodEdges('g', 'gm_sod', 'gmAction', ['legalActor', 'categoryActor', 'directorActor'], 'gm_self', 'record_gm', 'gm_review'),
    { id: 'e_g_next', source: 'record_gm', target: 'mark_signing', type: 'default' },

    { id: 'e_signing', source: 'mark_signing', target: 'notify_signing', type: 'default' },
    { id: 'e_signing_end', source: 'notify_signing', target: 'end', type: 'default' },

    { id: 'e_l_rejected', source: 'legal_reject_action', target: 'rejected_or_recalled', type: 'default' },
    { id: 'e_c_rejected', source: 'category_reject_action', target: 'rejected_or_recalled', type: 'default' },
    { id: 'e_d_rejected', source: 'director_reject_action', target: 'rejected_or_recalled', type: 'default' },
    { id: 'e_g_rejected', source: 'gm_reject_action', target: 'rejected_or_recalled', type: 'default' },
    { id: 'e_rejected', source: 'rejected_or_recalled', target: 'mark_rejected', type: 'conditional', condition: P`rejectAction != null`, label: '驳回' },
    { id: 'e_recalled', source: 'rejected_or_recalled', target: 'end', type: 'conditional', condition: P`rejectAction == null`, label: '撤回' },
    { id: 'e_rejected_notify', source: 'mark_rejected', target: 'notify_rejected', type: 'default' },
    { id: 'e_rejected_end', source: 'notify_rejected', target: 'end', type: 'default' },

    { id: 'e_resubmit', source: 'revise_window', target: 'legal_review', type: 'back', label: 'resubmit' },
  ],
};
