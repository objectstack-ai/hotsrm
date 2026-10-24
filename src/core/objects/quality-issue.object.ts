import { P, cel } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 质量整改单 SCAR / 8D（02 §4.6、§5.6，03 §8，FR-602–606）。主要 / 严重不合格的交付记录由 srm_scar_create 自动开单；
// 客户投诉、制程等来源由 SQE 手工新建。v0.6 门户上线前供应商的回复（D3、D4–D7）由 SQE 代填：填好 D3 把状态改为
// 「已提交临时措施」，填好 D4–D7 改为「已提交根因与措施」，后者触发 srm_scar_review 由负责 SQE 审核；
// 审核通过进入「效果验证」，SQE 跟踪后续批次确认有效后关闭（D8）。复发时重新打开（srm_scar_reopen 重算期限），
// 误判撤销。逾期由 srm_scar_overdue_sweep 置标志并通知 SQE 与质量经理（FR-605）。
// 时限取 params/core.yaml：scar_containment_hours（示例 72 小时）、scar_final_days（示例 30 天），客户改参数时同步这里。
const celOf = (source: string) => ({ dialect: 'cel' as const, source });
const blank = (k: string) => `(!has(record.${k}) || record.${k} == null || isBlank(record.${k}))`;
const ended = P`record.status == 'closed' || record.status == 'cancelled'`;

export const QualityIssue = ObjectSchema.create({
  name: 'srm_quality_issue',
  label: '整改单',
  pluralLabel: '整改单',
  icon: 'clipboard-x',
  // 临时：目标是 public_read + 质量岗位「改所有记录」。自动开的整改单属于系统，SQE 之间要互相接手，
  // 平台的 modifyAllRecords 会连删除一起放开（objectstack#25470），只能先放宽 OWD；能改哪些字段由 allowEdit
  // 与 FLS 决定，删除仍受 allowDelete 约束。portal_position 与门户 RLS 在 v0.6 加（ADR-0003）
  sharingModel: 'public_read_write',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'issue_no',

  fieldGroups: [
    { key: 'problem', label: '问题（D1–D2）', icon: 'clipboard-x' },
    { key: 'response', label: '供应商回复（D3–D7）', icon: 'wrench' },
    { key: 'review', label: '审核与期限', icon: 'shield-check' },
    { key: 'claim', label: '索赔', icon: 'receipt' },
  ],

  fields: {
    issue_no: Field.autonumber({ label: '整改单号', group: 'problem', autonumberFormat: 'SCAR{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'problem',
      required: true,
      readonlyWhen: ended,
      relatedListColumns: ['issue_no', 'source', 'severity', 'material', 'status', 'is_overdue', 'final_due', 'sqe'],
    }),
    material: Field.lookup('srm_material', { label: '物料', group: 'problem', displayField: 'erp_material_no', readonlyWhen: ended }),
    delivery_record: Field.lookup('srm_delivery_record', { label: '来源交付记录', group: 'problem', readonly: true }),
    // 审核问题项经「转整改单」生成时写入（srm_audit_finding_to_scar，v0.4 Q3）
    audit: Field.lookup('srm_supplier_audit', {
      label: '来源审核',
      group: 'problem',
      readonly: true,
      relatedListColumns: ['issue_no', 'severity', 'status', 'final_due', 'sqe'],
    }),
    source: Field.select({ label: '来源', group: 'problem', required: true, defaultValue: 'iqc', picklist: 'srm_quality_issue_source', readonlyWhen: ended }),
    severity: Field.select({
      label: '严重度',
      group: 'problem',
      required: true,
      readonlyWhen: ended,
      options: [
        { label: '严重', value: 'critical' },
        { label: '主要', value: 'major' },
        { label: '次要', value: 'minor' },
      ],
    }),
    problem_description: Field.richtext({ label: '问题描述（D2）', group: 'problem', required: true, readonlyWhen: ended }),

    // D3 临时措施；提交后必填。D4–D7 根因与永久措施；提交后必填
    containment_action: Field.richtext({
      label: '临时措施（D3）',
      group: 'response',
      readonlyWhen: ended,
      requiredWhen: P`record.status != 'open' && record.status != 'cancelled'`,
    }),
    root_cause: Field.richtext({
      label: '根本原因（D4）',
      group: 'response',
      readonlyWhen: ended,
      requiredWhen: P`record.status == 'action_submitted' || record.status == 'verifying' || record.status == 'closed'`,
    }),
    corrective_action: Field.richtext({
      label: '纠正措施（D5–D6）',
      group: 'response',
      readonlyWhen: ended,
      requiredWhen: P`record.status == 'action_submitted' || record.status == 'verifying' || record.status == 'closed'`,
    }),
    preventive_action: Field.richtext({ label: '预防措施（D7）', group: 'response', readonlyWhen: ended }),
    evidence: Field.file({ label: '整改证据', group: 'response', multiple: true, readonlyWhen: ended }),

    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'open',
      options: [
        { label: '待供应商响应', value: 'open', kind: 'open' },
        { label: '已提交临时措施', value: 'containment_submitted', kind: 'open' },
        { label: '已提交根因与措施', value: 'action_submitted', kind: 'open' },
        { label: '效果验证', value: 'verifying', kind: 'open' },
        { label: '已关闭', value: 'closed', kind: 'won' },
        { label: '已撤销', value: 'cancelled', kind: 'lost' },
      ],
    }),
    sqe: Field.user({ label: '负责 SQE', group: 'review', readonlyWhen: ended }),
    // 创建时计算（重新打开时由 srm_scar_reopen 重算）：临时措施 scar_containment_hours 小时，最终回复 scar_final_days 天
    containment_due: Field.datetime({ label: '临时措施期限', group: 'review', readonly: true, defaultValue: cel`now() + duration('72h')` }),
    final_due: Field.date({ label: '最终回复期限', group: 'review', readonly: true, defaultValue: cel`addDays(today(), 30)` }),
    // 退回时必填（FR-604）；SQE 在审批里退回时由 srm_scar_review 写入
    sqe_comment: Field.textarea({ label: 'SQE 审核意见', group: 'review', maxLength: 2000 }),
    is_overdue: Field.boolean({ label: '逾期', group: 'review', defaultValue: false, readonly: true }),

    // 索赔只记结论，供财务在 ERP 扣款时参考，SRM 不生成扣款（ADR-0008）。「已扣款」只由应付会计标记
    claim_amount: Field.currency({ label: '索赔金额', group: 'claim', min: 0 }),
    claim_status: Field.select({
      label: '索赔状态',
      group: 'claim',
      defaultValue: 'none',
      options: [
        { label: '无索赔', value: 'none' },
        { label: '已提出', value: 'proposed' },
        { label: '供应商已接受', value: 'supplier_accepted' },
        { label: '有异议', value: 'disputed' },
        {
          label: '已扣款',
          value: 'settled',
          visibleWhen: P`(previous != null && has(previous.claim_status) && previous.claim_status == 'settled') || (current_user != null && 'srm_ap_accountant' in current_user.positions)`,
        },
      ],
    }),
  },

  validations: [
    {
      name: 'quality_issue_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '整改单状态不允许这样变更',
      initialStates: ['open'],
      transitions: {
        open: ['containment_submitted', 'cancelled'],
        containment_submitted: ['action_submitted', 'open'],
        action_submitted: ['verifying', 'containment_submitted'],
        verifying: ['closed', 'action_submitted'],
        closed: ['open'],
        cancelled: [],
      },
    },
    {
      // 退回（D4–D7 退回到 D3，或 D3 退回到待响应）必须写明意见（FR-604）
      name: 'return_needs_comment',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '退回整改单时必须填写 SQE 审核意见',
      condition: celOf(`${blank('sqe_comment')} && has(previous.status) && ((previous.status == 'action_submitted' && record.status == 'containment_submitted') || (previous.status == 'containment_submitted' && record.status == 'open'))`),
    },
    {
      name: 'claim_needs_amount',
      type: 'script',
      severity: 'error',
      message: '提出索赔时填写索赔金额',
      condition: cel`has(record.claim_status) && record.claim_status != null && record.claim_status != 'none' && (!has(record.claim_amount) || record.claim_amount == null || record.claim_amount <= 0)`,
    },
    {
      // 财务在 ERP 扣款后才标记「已扣款」，只能从「供应商已接受」标记（03 §8 第 6 步）
      name: 'claim_settled_after_accepted',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '只有供应商已接受的索赔才能标记为已扣款',
      condition: cel`record.claim_status == 'settled' && has(previous.claim_status) && previous.claim_status != 'settled' && previous.claim_status != 'supplier_accepted'`,
    },
    {
      name: 'claim_settled_on_insert',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只有供应商已接受的索赔才能标记为已扣款',
      condition: P`has(record.claim_status) && record.claim_status == 'settled'`,
    },
  ],
});
