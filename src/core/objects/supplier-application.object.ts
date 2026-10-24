import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 准入申请（02 §4.2、§5.2）。v0.1 由内部人员为已登记的潜在供应商发起：没有公开表单和门户，
// 所以申请直接关联供应商，申请品类用多值 lookup；现场审核分支随供应商审核对象加入（v0.4）：
// 高风险品类的申请要有通过或有条件通过的准入审核才能进入准入评审（FR-204）。
// v0.3 起淘汰供应商可以重新申请（沿用旧档），黑名单供应商的申请由受理 flow 自动驳回（FR-208、BR-02）。
export const SupplierApplication = ObjectSchema.create({
  name: 'srm_supplier_application',
  label: '准入申请',
  pluralLabel: '准入申请',
  icon: 'clipboard-check',
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'application_no',

  fieldGroups: [
    { key: 'application', label: '申请信息', icon: 'clipboard-check' },
    { key: 'review', label: '审核', icon: 'shield-check' },
  ],

  fields: {
    application_no: Field.autonumber({ label: '申请编号', group: 'application', autonumberFormat: 'APP{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', { label: '供应商', group: 'application', required: true }),
    applied_categories: {
      type: 'lookup',
      label: '申请品类',
      group: 'application',
      reference: 'srm_category',
      multiple: true,
      required: true,
    },
    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'submitted',
      options: [
        { label: '已提交', value: 'submitted', kind: 'open' },
        { label: '资料审核', value: 'doc_review', kind: 'open' },
        { label: '退回补充', value: 'returned', kind: 'open' },
        { label: '准入评审', value: 'admission_review', kind: 'open' },
        { label: '准入通过', value: 'approved', kind: 'won' },
        { label: '未通过', value: 'rejected', kind: 'lost' },
      ],
    }),
    // 受理 flow 写入的查重结论，只读。内部登记时供应商已由唯一约束查重，所以不会出现 duplicate；
    // 公开表单 / 门户申请（v0.6）不预先关联供应商，才会按身份标识命中在册供应商
    duplicate_check: Field.select({
      label: '查重结论',
      group: 'review',
      readonly: true,
      options: [
        { label: '通过', value: 'pass' },
        { label: '重复', value: 'duplicate' },
        { label: '黑名单', value: 'blacklisted' },
        { label: '淘汰后重新准入', value: 'reapply' },
      ],
    }),
    // 受理 flow 从申请品类复制的最高物资类别与风险等级，只读；A 类或高风险时准入审批加质量经理会签（03 §12）
    material_class: Field.select({ label: '物资类别', group: 'review', readonly: true, picklist: 'srm_material_class' }),
    risk_class: Field.select({
      label: '风险等级',
      group: 'review',
      readonly: true,
      options: [
        { label: '高', value: 'high' },
        { label: '中', value: 'medium' },
        { label: '低', value: 'low' },
      ],
    }),
    // 准入审核完成时由 srm_audit_admission_apply 写入（03 §3 第 5 步），只读；审核报告在审核记录上
    audit_passed: Field.boolean({ label: '现场审核通过', group: 'review', defaultValue: false, readonly: true }),
    // 有条件通过的申请批准后品类资格为「试供」（WI-01 6.6.2）
    audit_result: Field.select({
      label: '现场审核结论',
      group: 'review',
      readonly: true,
      options: [
        { label: '通过', value: 'pass' },
        { label: '有条件通过', value: 'conditional' },
        { label: '不通过', value: 'fail' },
      ],
    }),
    reviewer: Field.user({ label: '初审人', group: 'review' }),
    // 审批节点写入的审批结论，只读
    approval_status: Field.select({
      label: '审批结论',
      group: 'review',
      readonly: true,
      options: [
        { label: '审批中', value: 'pending' },
        { label: '已批准', value: 'approved' },
        { label: '已驳回', value: 'rejected' },
      ],
    }),
    approved_date: Field.date({ label: '批准日期', group: 'review', readonly: true }),
    reject_reason: Field.textarea({ label: '未通过原因', group: 'review' }),
  },

  validations: [
    {
      name: 'application_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '准入申请状态不允许这样变更',
      initialStates: ['submitted'],
      transitions: {
        submitted: ['doc_review', 'rejected'],
        doc_review: ['admission_review', 'returned', 'rejected'],
        returned: ['doc_review'],
        admission_review: ['approved', 'rejected', 'doc_review'],
      },
    },
    {
      // 只有潜在或已淘汰的供应商能发起准入（02 §5.1：淘汰后只能经新的准入申请重新走全流程）。
      // 黑名单供应商的申请放行建档，由受理 flow 自动驳回并留下记录（BR-02）
      name: 'supplier_admissible',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只有「潜在」或「淘汰」状态的供应商可以发起准入申请',
      condition: P`has(record.supplier.status) && record.supplier.status != 'potential' && record.supplier.status != 'eliminated' && record.supplier.status != 'blacklisted'`,
    },
    {
      // 评审要有初审人：第 1 级审批人取自该字段
      name: 'reviewer_before_review',
      type: 'script',
      severity: 'error',
      message: '进入准入评审前需要指定初审人',
      condition: P`record.status == 'admission_review' && (!has(record.reviewer) || record.reviewer == null || isBlank(record.reviewer))`,
    },
    {
      // 高风险品类以现场审核为前置（FR-204，03 §3 第 5 步）
      name: 'audit_before_review',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '高风险品类的申请要有通过或有条件通过的现场审核，才能进入准入评审',
      condition: P`record.status == 'admission_review' && has(previous.status) && previous.status != 'admission_review' && has(record.risk_class) && record.risk_class == 'high' && record.audit_passed != true`,
    },
    {
      name: 'reject_reason_required',
      type: 'script',
      severity: 'error',
      message: '未通过时需要填写原因',
      condition: P`record.status == 'rejected' && (!has(record.reject_reason) || record.reject_reason == null || isBlank(record.reject_reason))`,
    },
  ],
});
