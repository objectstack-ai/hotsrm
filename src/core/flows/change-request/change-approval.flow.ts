import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 信息变更审批（03 §5，FR-207，BR-11）：变更单新建即快照当前档案到 before_value，然后审批：
// 第 1 级采购主管（srm_buyer_lead）；银行账户变更再加第 2 级应付会计（srm_ap_accountant）。
// 第 1 级可以通过、驳回或退回修改，退回后发起人改完重新提交、重新审批；第 2 级只能通过或驳回（见下）。
// 通过后经 srm_change_apply 写回档案；驳回不改主记录，把驳回意见写进 reject_reason 并通知发起人。
//
// 职责分离：发起人不能审批本人的变更单，两级审批人不能是同一人。平台审批服务还没有「提交人不得
// 审批本人单据」的开关（objectstack#25446），岗位又可能兼任，所以每级通过后由 flow 读审批记录比对：
// 撞人时这次通过不算数，通知审批人后重新开一轮同级审批（临时做法，平台支持后改为节点配置）。
const snapshotOf = (v: string, keys: string[]) => ({
  dialect: 'cel' as const,
  source: `{${keys.map((k) => `'${k}': has(${v}.${k}) ? ${v}.${k} : null`).join(', ')}}`,
});

const approval = (label: string, position: string, maxRevisions: number) => ({
  type: 'approval' as const,
  label,
  config: {
    approvers: [{ type: 'position' as const, value: position }],
    // 岗位没人时交给组织管理员，避免变更单卡在锁定状态
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

export const ChangeApprovalFlow: Automation.Flow = {
  name: 'srm_change_approval',
  label: '信息变更审批',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建变更单',
      config: {
        objectName: 'srm_supplier_change_request',
        triggerType: 'record-after-create',
        condition: P`record.status == 'in_review'`,
      },
    },

    // 1. 快照变更前的档案（银行账号不进快照，BR-20）
    { id: 'snapshot_by_type', type: 'decision', label: '按变更类型快照' },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'supplier' },
    },
    {
      id: 'snapshot_supplier',
      type: 'update_record',
      label: '快照供应商档案',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`record.id` },
        fields: {
          before_value: snapshotOf('supplier', ['name', 'credit_code', 'registration_no', 'legal_representative', 'registered_capital', 'address']),
        },
      },
    },
    {
      id: 'load_account',
      type: 'get_record',
      label: '读取原银行账户',
      config: { objectName: 'srm_supplier_bank_account', filter: { id: cel`record.bank_account` }, outputVariable: 'account' },
    },
    {
      id: 'snapshot_account',
      type: 'update_record',
      label: '快照原银行账户',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`record.id` },
        fields: {
          before_value: snapshotOf('account', ['id', 'bank_name', 'branch_name', 'account_name', 'swift_code', 'currency', 'status', 'is_default']),
        },
      },
    },
    {
      id: 'load_contact',
      type: 'get_record',
      label: '读取联系人',
      config: { objectName: 'srm_supplier_contact', filter: { id: cel`record.contact` }, outputVariable: 'contact' },
    },
    {
      id: 'snapshot_contact',
      type: 'update_record',
      label: '快照联系人',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`record.id` },
        fields: { before_value: snapshotOf('contact', ['id', 'name', 'mobile', 'email']) },
      },
    },

    // 2. 第 1 级：采购主管
    { id: 'purchase_review', ...approval('采购主管审批', 'srm_buyer_lead', 3) },
    actionOf('purchase_action', '读取采购审批记录', 'purchase_review', 'approve', 'purchaseAction'),
    { id: 'purchase_sod', type: 'decision', label: '采购审批人是发起人？' },
    {
      id: 'purchase_self',
      type: 'notify',
      label: '发起人不能审批本人的变更单',
      config: {
        recipients: cel`purchaseAction.actor_id`,
        title: '变更单 {{ record.change_no }} 需由另一位采购主管审批',
        message: '你是这张变更单的发起人，你的通过不计入审批，已重新提交给采购主管。',
        severity: 'warning',
        sourceObject: 'srm_supplier_change_request',
        sourceId: cel`record.id`,
      },
    },
    {
      id: 'record_purchase',
      type: 'update_record',
      label: '记录采购审批人',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`record.id` },
        fields: { purchase_approver: cel`purchaseAction.actor_id` },
      },
    },
    { id: 'needs_finance', type: 'decision', label: '银行账户变更？' },

    // 3. 第 2 级：应付会计（只有银行账户变更）。临时做法：这一级只能通过或驳回、不能退回修改——平台把
    // 第 2 个审批节点的提交人记成恢复流程的人（第 1 级审批人），退回后只有他能重新提交，发起人反而不能
    // （objectstack#24817 已在主干修复、18.0.0 未带上）。平台修复后加回 revise 边，退回到发起人
    { id: 'finance_review', ...approval('应付会计复核', 'srm_ap_accountant', 0) },
    actionOf('finance_action', '读取财务审批记录', 'finance_review', 'approve', 'financeAction'),
    { id: 'finance_sod', type: 'decision', label: '财务审批人与发起人、采购审批人不同？' },
    {
      id: 'finance_self',
      type: 'notify',
      label: '两级审批人不能是同一人',
      config: {
        recipients: cel`financeAction.actor_id`,
        title: '变更单 {{ record.change_no }} 需由另一位应付会计复核',
        message: '银行账户变更的发起人、采购审批人和财务复核人不能是同一人（BR-11），你的通过不计入审批，已重新提交给应付会计。',
        severity: 'warning',
        sourceObject: 'srm_supplier_change_request',
        sourceId: cel`record.id`,
      },
    },
    {
      id: 'record_finance',
      type: 'update_record',
      label: '记录财务审批人',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`record.id` },
        fields: { finance_approver: cel`financeAction.actor_id` },
      },
    },

    // 4. 通过：写回档案
    {
      id: 'apply',
      type: 'subflow',
      label: '写回档案',
      config: { flowName: 'srm_change_apply', input: { recordId: cel`record.id` } },
    },
    {
      id: 'notify_applied',
      type: 'notify',
      label: '通知发起人：已生效',
      config: {
        recipients: cel`record.created_by`,
        title: '变更单 {{ record.change_no }} 已审批通过并生效',
        message: '变更内容已写回供应商档案。',
        sourceObject: 'srm_supplier_change_request',
        sourceId: cel`record.id`,
      },
    },

    // 5. 驳回：不改主记录，记下驳回意见
    actionOf('purchase_reject_action', '读取采购驳回意见', 'purchase_review', 'reject', 'rejectAction'),
    actionOf('finance_reject_action', '读取财务驳回意见', 'finance_review', 'reject', 'rejectAction'),
    {
      id: 'mark_rejected',
      type: 'update_record',
      label: '变更单已驳回',
      config: {
        objectName: 'srm_supplier_change_request',
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
        title: '变更单 {{ record.change_no }} 已驳回',
        message: '供应商档案未作修改，驳回原因见变更单。',
        severity: 'warning',
        sourceObject: 'srm_supplier_change_request',
        sourceId: cel`record.id`,
      },
    },

    // 6. 退回修改：记录解锁，发起人改完后重新提交，从第 1 级重新审批
    { id: 'revise_window', type: 'approval_revise', label: '退回修改' },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e_start', source: 'start', target: 'snapshot_by_type', type: 'default' },
    {
      id: 'e_snap_supplier',
      source: 'snapshot_by_type',
      target: 'load_supplier',
      type: 'conditional',
      condition: P`record.change_type == 'basic' || record.change_type == 'address'`,
      label: '供应商档案',
    },
    {
      id: 'e_snap_account',
      source: 'snapshot_by_type',
      target: 'load_account',
      type: 'conditional',
      condition: P`record.change_type == 'bank_account'`,
      label: '银行账户',
    },
    {
      id: 'e_snap_contact',
      source: 'snapshot_by_type',
      target: 'load_contact',
      type: 'conditional',
      condition: P`record.change_type == 'contact'`,
      label: '联系人',
    },
    { id: 'e_supplier', source: 'load_supplier', target: 'snapshot_supplier', type: 'default' },
    { id: 'e_account', source: 'load_account', target: 'snapshot_account', type: 'default' },
    { id: 'e_contact', source: 'load_contact', target: 'snapshot_contact', type: 'default' },
    { id: 'e_review_1', source: 'snapshot_supplier', target: 'purchase_review', type: 'default' },
    { id: 'e_review_2', source: 'snapshot_account', target: 'purchase_review', type: 'default' },
    { id: 'e_review_3', source: 'snapshot_contact', target: 'purchase_review', type: 'default' },

    { id: 'e_p_approve', source: 'purchase_review', target: 'purchase_action', type: 'default', label: 'approve' },
    { id: 'e_p_reject', source: 'purchase_review', target: 'purchase_reject_action', type: 'default', label: 'reject' },
    { id: 'e_p_revise', source: 'purchase_review', target: 'revise_window', type: 'default', label: 'revise' },
    { id: 'e_p_sod', source: 'purchase_action', target: 'purchase_sod', type: 'default' },
    {
      id: 'e_p_self',
      source: 'purchase_sod',
      target: 'purchase_self',
      type: 'conditional',
      condition: P`purchaseAction.actor_id == record.created_by`,
      label: '是发起人',
    },
    {
      id: 'e_p_ok',
      source: 'purchase_sod',
      target: 'record_purchase',
      type: 'conditional',
      condition: P`purchaseAction.actor_id != record.created_by`,
      label: '不是发起人',
    },
    { id: 'e_p_again', source: 'purchase_self', target: 'purchase_review', type: 'back', label: '重新审批' },
    { id: 'e_p_next', source: 'record_purchase', target: 'needs_finance', type: 'default' },
    {
      id: 'e_finance',
      source: 'needs_finance',
      target: 'finance_review',
      type: 'conditional',
      condition: P`record.change_type == 'bank_account'`,
      label: '银行账户变更',
    },
    {
      id: 'e_no_finance',
      source: 'needs_finance',
      target: 'apply',
      type: 'conditional',
      condition: P`record.change_type != 'bank_account'`,
      label: '其他变更',
    },

    { id: 'e_f_approve', source: 'finance_review', target: 'finance_action', type: 'default', label: 'approve' },
    { id: 'e_f_reject', source: 'finance_review', target: 'finance_reject_action', type: 'default', label: 'reject' },
    { id: 'e_f_sod', source: 'finance_action', target: 'finance_sod', type: 'default' },
    {
      id: 'e_f_self',
      source: 'finance_sod',
      target: 'finance_self',
      type: 'conditional',
      condition: P`financeAction.actor_id == record.created_by || financeAction.actor_id == purchaseAction.actor_id`,
      label: '撞人',
    },
    {
      id: 'e_f_ok',
      source: 'finance_sod',
      target: 'record_finance',
      type: 'conditional',
      condition: P`financeAction.actor_id != record.created_by && financeAction.actor_id != purchaseAction.actor_id`,
      label: '不同的人',
    },
    { id: 'e_f_again', source: 'finance_self', target: 'finance_review', type: 'back', label: '重新复核' },
    { id: 'e_f_next', source: 'record_finance', target: 'apply', type: 'default' },

    { id: 'e_applied', source: 'apply', target: 'notify_applied', type: 'default' },
    { id: 'e_applied_end', source: 'notify_applied', target: 'end', type: 'default' },

    { id: 'e_p_rejected', source: 'purchase_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_f_rejected', source: 'finance_reject_action', target: 'mark_rejected', type: 'default' },
    { id: 'e_rejected', source: 'mark_rejected', target: 'notify_rejected', type: 'default' },
    { id: 'e_rejected_end', source: 'notify_rejected', target: 'end', type: 'default' },

    { id: 'e_resubmit', source: 'revise_window', target: 'purchase_review', type: 'back', label: 'resubmit' },
  ],
};
