import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 合同 / 协议（02 §4.4、§5.5，03 §6）。品类经理起草 → 提交审批（srm_contract_submit）→ 审批（srm_contract_approval，v0.3 C2）
// → 签署中上传双方盖章件、填签署日期 → 确认生效（srm_contract_activate）→ 到期扫描置为已到期（srm_contract_expire_sweep）。
// 状态只由 flow 写入。合同内容只在草稿期间和被退回修改期间可改（审批中平台锁定记录）；签署件与签署日期只在签署中可改。
// 电子签（esign_request_id）、ERP 合同号、来源寻源单（v0.7 随寻源单加入）预留，现阶段不写。
const notDraft = P`record.status != 'draft' && record.approval_status != 'returned'`;
const notSigning = P`record.status != 'signing'`;
const blank = (k: string) => `(!has(record.${k}) || record.${k} == null || isBlank(record.${k}))`;

export const Contract = ObjectSchema.create({
  name: 'srm_contract',
  label: '合同',
  pluralLabel: '合同',
  icon: 'file-signature',
  // 读靠权限集的 viewAllRecords。品类经理、采购主管互相接手草稿，法务改条款，采购员给别人建的合同上传签署件，
  // 靠按岗位授 edit 的共享规则 srm_contract_edit_*（可改不可删，objectstack#25470 的裁定写法，02 §4.4）；
  // 能改哪些字段由 allowEdit 与 FLS 决定
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'title',

  fieldGroups: [
    { key: 'contract', label: '合同信息', icon: 'file-signature' },
    { key: 'review', label: '审批', icon: 'stamp' },
    { key: 'signing', label: '签署', icon: 'pen-line' },
    { key: 'external', label: '外部系统', icon: 'link' },
  ],

  fields: {
    contract_no: Field.autonumber({ label: '合同编号', group: 'contract', autonumberFormat: 'CT{YYYY}{00000}' }),
    title: Field.text({ label: '合同名称', group: 'contract', required: true, searchable: true, maxLength: 200, readonlyWhen: notDraft }),
    contract_type: Field.select({ label: '合同类型', group: 'contract', required: true, picklist: 'srm_contract_type', readonlyWhen: notDraft }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'contract',
      required: true,
      readonlyWhen: notDraft,
      relatedListColumns: ['contract_no', 'title', 'contract_type', 'status', 'start_date', 'end_date', 'amount'],
    }),
    // 到期提醒通知这个品类的品类经理
    category: Field.lookup('srm_category', { label: '主要品类', group: 'contract', readonlyWhen: notDraft }),
    legal_entity: Field.text({ label: '签约法人', group: 'contract', maxLength: 200, readonlyWhen: notDraft }),
    // 合同金额：采购合同为合同总额，框架协议为年度预计金额；合同审批按它分档（03 §12）
    amount: Field.currency({ label: '合同金额', group: 'contract', readonlyWhen: notDraft }),
    currency: Field.select({
      label: '币种',
      group: 'contract',
      defaultValue: 'cny',
      readonlyWhen: notDraft,
      options: [
        { label: '人民币', value: 'cny' },
        { label: '美元', value: 'usd' },
        { label: '欧元', value: 'eur' },
        { label: '日元', value: 'jpy' },
        { label: '港币', value: 'hkd' },
      ],
    }),
    line_amount: Field.summary({
      label: '明细金额合计',
      group: 'contract',
      summaryOperations: { object: 'srm_contract_line', field: 'amount', function: 'sum' },
    }),
    start_date: Field.date({ label: '生效日期', group: 'contract', required: true, readonlyWhen: notDraft }),
    end_date: Field.date({ label: '到期日期', group: 'contract', required: true, readonlyWhen: notDraft }),
    auto_renew: Field.boolean({ label: '到期自动续签', group: 'contract', defaultValue: false, readonlyWhen: notDraft }),
    legal_reviewer: Field.user({ label: '法务审核人', group: 'contract', readonlyWhen: notDraft }),
    status: Field.select({
      label: '状态',
      group: 'contract',
      defaultValue: 'draft',
      readonly: true,
      options: [
        { label: '草稿', value: 'draft', kind: 'open' },
        { label: '审批中', value: 'in_review', kind: 'open' },
        { label: '签署中', value: 'signing', kind: 'open' },
        { label: '生效', value: 'active', kind: 'won' },
        { label: '已到期', value: 'expired', kind: 'lost' },
        { label: '已终止', value: 'terminated', kind: 'lost' },
        { label: '审批未通过', value: 'rejected', kind: 'lost' },
      ],
    }),
    // 自动续签生成的草稿指回原合同，由 srm_contract_renew 写入
    renewed_from: Field.lookup('srm_contract', { label: '续签自', group: 'contract', readonly: true }),

    // 审批（03 §6、§12）：提交人由 srm_contract_submit 写入，审批结论和各级审批人由 srm_contract_approval 写入
    submitted_by: Field.user({ label: '提交人', group: 'review', readonly: true }),
    // 审批节点写入的审批结论；returned = 退回修改，合同内容解锁
    approval_status: Field.select({
      label: '审批结论',
      group: 'review',
      readonly: true,
      options: [
        { label: '审批中', value: 'pending' },
        { label: '已批准', value: 'approved' },
        { label: '已驳回', value: 'rejected' },
        { label: '退回修改', value: 'returned' },
        { label: '已撤回', value: 'recalled' },
      ],
    }),
    legal_approver: Field.user({ label: '法务审批人', group: 'review', readonly: true }),
    category_approver: Field.user({ label: '品类经理审批人', group: 'review', readonly: true }),
    director_approver: Field.user({ label: '采购总监审批人', group: 'review', readonly: true }),
    gm_approver: Field.user({ label: '总经理审批人', group: 'review', readonly: true }),
    reject_reason: Field.textarea({ label: '驳回原因', group: 'review', readonly: true }),

    signed_file: Field.file({ label: '签署件', group: 'signing', readonlyWhen: notSigning }),
    signed_date: Field.date({ label: '签署日期', group: 'signing', readonlyWhen: notSigning }),

    esign_request_id: Field.text({ label: '电子签流水号', group: 'external', maxLength: 100, readonly: true }),
    erp_contract_no: Field.text({ label: 'ERP 合同号', group: 'external', unique: true, maxLength: 40, readonly: true }),
  },

  validations: [
    {
      name: 'contract_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '合同状态不允许这样变更',
      initialStates: ['draft'],
      transitions: {
        draft: ['in_review'],
        in_review: ['draft', 'signing', 'rejected'],
        signing: ['active', 'terminated'],
        active: ['expired', 'terminated'],
        expired: [],
        terminated: [],
        rejected: [],
      },
    },
    {
      name: 'end_date_after_start_date',
      type: 'script',
      severity: 'error',
      message: '到期日期不能早于生效日期',
      condition: P`has(record.start_date) && has(record.end_date) && record.start_date != null && record.end_date != null && record.end_date < record.start_date`,
    },
    {
      // 只能对合格供应商建合同：潜在、准入中、冻结、淘汰、黑名单都不行（07 §2.1 第 7 步）。自动续签同样受限
      name: 'supplier_qualified',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只能与「合格」的供应商签订新合同',
      condition: P`has(record.supplier.status) && record.supplier.status != 'qualified'`,
    },
    {
      // 职责分离（BR-11）：起草人不能指定自己做法务审核人
      name: 'legal_reviewer_not_drafter',
      type: 'script',
      severity: 'error',
      message: '法务审核人不能是合同起草人',
      condition: P`has(record.legal_reviewer) && record.legal_reviewer != null && has(record.created_by) && record.legal_reviewer == record.created_by`,
    },
    {
      // 生效必须有签署件和签署日期（03 §6 第 3–4 步）；确认生效的 screen flow 先查一遍，这里兜底
      name: 'signed_before_active',
      type: 'script',
      severity: 'error',
      message: '请先上传签署件并填写签署日期',
      condition: { dialect: 'cel', source: `record.status == 'active' && (${blank('signed_file')} || ${blank('signed_date')})` },
    },
  ],
});
