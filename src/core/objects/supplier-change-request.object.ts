import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 信息变更单（02 §4.2，03 §5，FR-207，BR-11）。门户上线前由采购员代供应商发起：在供应商档案下新建，
// 填写变更后的值；新建即进入审批（srm_change_approval），审批通过后由 flow 写回供应商、银行账户或联系人。
// 变更后的值放在本单的分类型字段里（表单可校验、退回后可修改），before_value / after_value 是 flow 写入的
// json 快照，供审计对照。银行账号不进快照（BR-20：本单对采购员可读，快照没有脱敏规则）。
// 供应商、类型和要改的对象只在新建时填写（readonlyWhen 不管新建；三个状态覆盖了所有已建记录）
const created = P`record.status == 'in_review' || record.status == 'applied' || record.status == 'rejected'`;
// 变更内容只在新建时和被退回修改期间可改；审批中平台锁定记录，审结后只读
const proposal = P`record.approval_status != 'returned'`;

export const SupplierChangeRequest = ObjectSchema.create({
  name: 'srm_supplier_change_request',
  label: '信息变更单',
  pluralLabel: '信息变更单',
  icon: 'file-pen',
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'change_no',

  fieldGroups: [
    { key: 'request', label: '变更申请', icon: 'file-pen' },
    { key: 'basic', label: '基本信息变更', icon: 'building' },
    { key: 'address', label: '地址变更', icon: 'map-pin' },
    { key: 'bank', label: '银行账户变更', icon: 'landmark' },
    { key: 'contact', label: '联系人变更', icon: 'contact' },
    { key: 'review', label: '审批与写回', icon: 'shield-check' },
  ],

  fields: {
    change_no: Field.autonumber({ label: '变更单号', group: 'request', autonumberFormat: 'CHG{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', { label: '供应商', group: 'request', required: true, readonlyWhen: created }),
    change_type: Field.select({
      label: '变更类型',
      group: 'request',
      required: true,
      readonlyWhen: created,
      options: [
        { label: '基本信息', value: 'basic' },
        { label: '银行账户', value: 'bank_account' },
        { label: '地址', value: 'address' },
        { label: '联系人', value: 'contact' },
      ],
    }),
    reason: Field.textarea({ label: '变更原因', group: 'request', required: true, readonlyWhen: proposal }),

    // 基本信息：只填要改的项，留空的保持原值
    new_name: Field.text({ label: '新公司全称', group: 'basic', maxLength: 200, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'basic'` }),
    new_credit_code: Field.text({ label: '新统一社会信用代码', group: 'basic', maxLength: 18, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'basic'` }),
    new_registration_no: Field.text({ label: '新注册号 / 税号', group: 'basic', maxLength: 50, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'basic'` }),
    new_legal_representative: Field.text({ label: '新法定代表人', group: 'basic', maxLength: 50, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'basic'` }),
    new_registered_capital: Field.currency({ label: '新注册资本', group: 'basic', readonlyWhen: proposal, visibleWhen: P`record.change_type == 'basic'` }),

    new_address: Field.address({
      label: '新注册地址',
      group: 'address',
      readonlyWhen: proposal,
      requiredWhen: P`record.change_type == 'address'`,
      visibleWhen: P`record.change_type == 'address'`,
    }),

    // 银行账户变更 = 用一个新账户替换一个有效账户：通过后新账户直接为「有效」，原账户停用
    bank_account: Field.lookup('srm_supplier_bank_account', {
      label: '原银行账户',
      group: 'bank',
      readonlyWhen: created,
      requiredWhen: P`record.change_type == 'bank_account'`,
      visibleWhen: P`record.change_type == 'bank_account'`,
    }),
    new_bank_name: Field.text({
      label: '新开户行',
      group: 'bank',
      maxLength: 100,
      readonlyWhen: proposal,
      requiredWhen: P`record.change_type == 'bank_account'`,
      visibleWhen: P`record.change_type == 'bank_account'`,
    }),
    new_branch_name: Field.text({ label: '新支行', group: 'bank', maxLength: 100, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'bank_account'` }),
    new_account_name: Field.text({
      label: '新账户名称',
      group: 'bank',
      maxLength: 200,
      readonlyWhen: proposal,
      requiredWhen: P`record.change_type == 'bank_account'`,
      visibleWhen: P`record.change_type == 'bank_account'`,
    }),
    // 与银行账户上的账号同样脱敏（BR-20，04 §4.2）
    new_account_no: Field.text({
      label: '新银行账号',
      group: 'bank',
      maxLength: 50,
      readonlyWhen: proposal,
      requiredWhen: P`record.change_type == 'bank_account'`,
      visibleWhen: P`record.change_type == 'bank_account'`,
      maskingRule: 'bank_account',
      requiredPermissions: ['srm_view_bank_account_no'],
    }),
    new_swift_code: Field.text({ label: '新 SWIFT 代码', group: 'bank', maxLength: 11, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'bank_account'` }),
    new_currency: Field.select({
      label: '新账户币种',
      group: 'bank',
      defaultValue: 'cny',
      readonlyWhen: proposal,
      visibleWhen: P`record.change_type == 'bank_account'`,
      options: [
        { label: '人民币', value: 'cny' },
        { label: '美元', value: 'usd' },
        { label: '欧元', value: 'eur' },
        { label: '日元', value: 'jpy' },
        { label: '港币', value: 'hkd' },
      ],
    }),

    contact: Field.lookup('srm_supplier_contact', {
      label: '联系人',
      group: 'contact',
      readonlyWhen: created,
      requiredWhen: P`record.change_type == 'contact'`,
      visibleWhen: P`record.change_type == 'contact'`,
    }),
    new_contact_name: Field.text({ label: '新姓名', group: 'contact', maxLength: 50, readonlyWhen: proposal, visibleWhen: P`record.change_type == 'contact'` }),
    new_mobile: Field.phone({ label: '新手机', group: 'contact', readonlyWhen: proposal, visibleWhen: P`record.change_type == 'contact'` }),
    new_email: Field.email({ label: '新邮箱', group: 'contact', readonlyWhen: proposal, visibleWhen: P`record.change_type == 'contact'` }),

    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'in_review',
      readonly: true,
      options: [
        { label: '审批中', value: 'in_review', kind: 'open' },
        { label: '已生效', value: 'applied', kind: 'won' },
        { label: '已驳回', value: 'rejected', kind: 'lost' },
      ],
    }),
    // 审批节点写入的审批结论；returned = 退回修改
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
    purchase_approver: Field.user({ label: '采购审批人', group: 'review', readonly: true }),
    finance_approver: Field.user({ label: '财务审批人', group: 'review', readonly: true }),
    reject_reason: Field.textarea({ label: '驳回原因', group: 'review', readonly: true }),
    applied_at: Field.datetime({ label: '写回时间', group: 'review', readonly: true }),
    new_bank_account: Field.lookup('srm_supplier_bank_account', { label: '新银行账户', group: 'review', readonly: true }),
    before_value: Field.json({ label: '变更前', group: 'review', readonly: true }),
    after_value: Field.json({ label: '变更后', group: 'review', readonly: true }),
  },

  validations: [
    {
      name: 'change_request_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '信息变更单状态不允许这样变更',
      initialStates: ['in_review'],
      transitions: {
        in_review: ['applied', 'rejected'],
        applied: [],
        rejected: [],
      },
    },
    {
      name: 'basic_change_not_empty',
      type: 'script',
      severity: 'error',
      message: '基本信息变更至少填写一项新值',
      condition: P`record.change_type == 'basic' && (!has(record.new_name) || record.new_name == null || isBlank(record.new_name)) && (!has(record.new_credit_code) || record.new_credit_code == null || isBlank(record.new_credit_code)) && (!has(record.new_registration_no) || record.new_registration_no == null || isBlank(record.new_registration_no)) && (!has(record.new_legal_representative) || record.new_legal_representative == null || isBlank(record.new_legal_representative)) && (!has(record.new_registered_capital) || record.new_registered_capital == null)`,
    },
    {
      name: 'new_credit_code_format',
      type: 'script',
      severity: 'error',
      message: '统一社会信用代码应为 18 位数字或大写字母',
      condition: P`has(record.new_credit_code) && record.new_credit_code != null && !isBlank(record.new_credit_code) && !record.new_credit_code.matches('^[0-9A-Z]{18}$')`,
    },
    {
      // 引用字段为空时不读关联记录（规则读不到会拒绝写入）
      name: 'bank_account_of_supplier_guard',
      type: 'conditional',
      message: '原银行账户必须属于这家供应商',
      when: P`has(record.bank_account) && record.bank_account != null`,
      then: {
        name: 'bank_account_of_supplier',
        type: 'script',
        severity: 'error',
        message: '原银行账户必须属于这家供应商',
        condition: P`record.change_type == 'bank_account' && has(record.bank_account.supplier) && record.bank_account.supplier != record.supplier`,
      },
    },
    {
      // 引用字段为空时不读关联记录（规则读不到会拒绝写入）
      name: 'bank_account_active_guard',
      type: 'conditional',
      events: ['insert'],
      message: '只能变更「有效」的银行账户',
      when: P`has(record.bank_account) && record.bank_account != null`,
      then: {
        // 只替换有效账户：待核验的账户还没生效，停用的账户不再收款
        name: 'bank_account_active',
        type: 'script',
        severity: 'error',
        events: ['insert'],
        message: '只能变更「有效」的银行账户',
        condition: P`record.change_type == 'bank_account' && has(record.bank_account.status) && record.bank_account.status != 'active'`,
      },
    },
    {
      // 与银行账户自身的规则一致：中国供应商的户名必须是供应商全称；提前在提交时拦住，免得审批通过后写不进去
      name: 'new_account_name_matches_supplier',
      type: 'script',
      severity: 'error',
      message: '新账户名称必须与供应商全称一致',
      condition: P`record.change_type == 'bank_account' && has(record.supplier.country) && record.supplier.country == 'cn' && has(record.supplier.name) && has(record.new_account_name) && record.new_account_name != record.supplier.name`,
    },
    {
      // 引用字段为空时不读关联记录（规则读不到会拒绝写入）
      name: 'contact_of_supplier_guard',
      type: 'conditional',
      message: '联系人必须属于这家供应商',
      when: P`has(record.contact) && record.contact != null`,
      then: {
        name: 'contact_of_supplier',
        type: 'script',
        severity: 'error',
        message: '联系人必须属于这家供应商',
        condition: P`record.change_type == 'contact' && has(record.contact.supplier) && record.contact.supplier != record.supplier`,
      },
    },
  ],
});
