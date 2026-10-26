import { P, cel } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商处置单（02 §4.2、§5.1，03 §5，FR-208）：品类经理（或采购主管）在供应商档案下新建，新建即进入审批
// （srm_disposition_approval），通过后由 srm_disposition_apply 以系统身份改供应商状态和品类资格。
// 动作与供应商当前状态的合法组合在新建时校验，与供应商状态机（02 §5.1）一致；同一家供应商同时
// 只能有一张审批中的处置单，免得两张单子审完后互相覆盖。
// 草稿（v0.5）：高风险事件（srm_risk_event_apply）和绩效结果应用（srm_performance_apply）由 flow 生成处置单草稿，品类经理或采购主管
// 核对后经「提交审批」（srm_disposition_submit）进入审批，或经「作废」（srm_disposition_cancel）放弃。
// 提交时同一套状态校验再跑一遍（供应商状态可能在草稿期间变了）。提交人记入 submitted_by 并接管记录所有权，
// 审批 flow 以它为发起人（手工新建的处置单没有 submitted_by，发起人是新建人）。
// 供应商、动作、范围和品类只在新建时填写。服务端新建时不看 readonlyWhen，新建表单却会按默认值
// （状态「审批中」）把字段锁住，所以先判断记录已保存（有 id）。
// 临时绕法（objectstack#25584），平台修复后去掉 id 判断
const created = P`has(record.id) && record.id != null`;
// 原因与生效日期只在新建时和被退回修改期间可改；审批中平台锁定记录，审结后只读。
// 草稿的原因由生成它的 flow 写好（如风险事件编号与描述），要换原因就作废草稿、手工新建
const proposal = P`has(record.id) && record.id != null && record.approval_status != 'returned'`;
// 动作与供应商状态的组合在新建和草稿提交时各校验一次；「只能有一张审批中」在新建（非草稿）和提交时校验
const allowedActions =
  `has(record.supplier.status) && !(`
  + `(record.action == 'freeze' && record.supplier.status == 'qualified')`
  + ` || (record.action == 'unfreeze' && record.scope == 'all' && record.supplier.status == 'frozen')`
  + ` || (record.action == 'unfreeze' && record.scope == 'category' && record.supplier.status == 'qualified')`
  + ` || (record.action == 'eliminate' && (record.supplier.status == 'potential' || record.supplier.status == 'qualified' || record.supplier.status == 'frozen'))`
  + ` || (record.action == 'blacklist' && (record.supplier.status == 'qualified' || record.supplier.status == 'frozen' || record.supplier.status == 'eliminated'))`
  + ` || (record.action == 'remove_blacklist' && record.supplier.status == 'blacklisted'))`;
const hasOpen = `has(record.supplier.open_disposition_count) && record.supplier.open_disposition_count > 0`;
const submitting = `has(previous.status) && previous.status == 'draft' && record.status == 'in_review'`;

export const SupplierDisposition = ObjectSchema.create({
  name: 'srm_supplier_disposition',
  label: '处置单',
  pluralLabel: '处置单',
  icon: 'ban',
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'disposition_no',

  fieldGroups: [
    { key: 'request', label: '处置申请', icon: 'ban' },
    { key: 'review', label: '审批与执行', icon: 'shield-check' },
  ],

  fields: {
    disposition_no: Field.autonumber({ label: '处置单号', group: 'request', autonumberFormat: 'DSP{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', { label: '供应商', group: 'request', required: true, readonlyWhen: created }),
    action: Field.select({
      label: '处置动作',
      group: 'request',
      required: true,
      readonlyWhen: created,
      options: [
        { label: '冻结', value: 'freeze' },
        { label: '解冻', value: 'unfreeze' },
        { label: '淘汰', value: 'eliminate' },
        { label: '拉入黑名单', value: 'blacklist' },
        { label: '解除黑名单', value: 'remove_blacklist' },
      ],
    }),
    // 指定品类只用于冻结 / 解冻：只暂停或恢复所选品类的资格，供应商状态不变
    scope: Field.select({
      label: '处置范围',
      group: 'request',
      required: true,
      defaultValue: 'all',
      readonlyWhen: created,
      options: [
        { label: '全部品类', value: 'all' },
        { label: '指定品类', value: 'category' },
      ],
    }),
    categories: {
      type: 'lookup',
      label: '处置品类',
      group: 'request',
      reference: 'srm_category',
      multiple: true,
      readonlyWhen: created,
      requiredWhen: P`record.scope == 'category'`,
      visibleWhen: P`record.scope == 'category'`,
    },
    reason: Field.textarea({ label: '处置原因', group: 'request', required: true, readonlyWhen: proposal }),
    // 审批通过即执行；生效日期记录业务上的生效日，供采购员在 ERP 同步冻结标志时参照
    effective_date: Field.date({ label: '生效日期', group: 'request', defaultValue: cel`today()`, readonlyWhen: proposal }),

    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'in_review',
      readonly: true,
      options: [
        { label: '草稿', value: 'draft', kind: 'open' },
        { label: '审批中', value: 'in_review', kind: 'open' },
        { label: '已执行', value: 'applied', kind: 'won' },
        { label: '已驳回', value: 'rejected', kind: 'lost' },
        { label: '已作废', value: 'cancelled', kind: 'lost' },
      ],
    }),
    // D 级绩效结果生成的草稿（srm_performance_apply，v0.5 P4）；申诉改变等级时品类经理按它找到草稿核对
    performance_review: Field.lookup('srm_performance_review', {
      label: '来源考评单',
      group: 'review',
      readonly: true,
      relatedListColumns: ['disposition_no', 'action', 'status', 'submitted_by', 'applied_at'],
    }),
    // 草稿的提交人（srm_disposition_submit 写入）；手工新建的处置单为空，发起人即新建人
    submitted_by: Field.user({ label: '提交人', group: 'review', readonly: true }),
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
    // 发起人不是品类经理时才有品类经理一级；品类经理发起时为空，发起人即是这一级
    category_approver: Field.user({ label: '品类经理审批人', group: 'review', readonly: true }),
    director_approver: Field.user({ label: '采购总监审批人', group: 'review', readonly: true }),
    gm_approver: Field.user({ label: '总经理审批人', group: 'review', readonly: true }),
    compliance_approver: Field.user({ label: '内控会签人', group: 'review', readonly: true }),
    reject_reason: Field.textarea({ label: '驳回原因', group: 'review', readonly: true }),
    applied_at: Field.datetime({ label: '执行时间', group: 'review', readonly: true }),
  },

  validations: [
    {
      name: 'disposition_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '处置单状态不允许这样变更',
      initialStates: ['in_review', 'draft'],
      transitions: {
        draft: ['in_review', 'cancelled'],
        in_review: ['applied', 'rejected'],
        applied: [],
        rejected: [],
        cancelled: [],
      },
    },
    {
      name: 'disposition_scope_by_action',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只有冻结和解冻可以指定品类；淘汰、黑名单和解除黑名单针对全部品类',
      condition: P`record.scope == 'category' && record.action != 'freeze' && record.action != 'unfreeze'`,
    },
    {
      name: 'disposition_categories_required',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '指定品类时至少选择一个品类',
      condition: P`record.scope == 'category' && (!has(record.categories) || record.categories == null || size(record.categories) == 0)`,
    },
    {
      // 与供应商状态机（02 §5.1）一致：冻结只对合格供应商；全部解冻只对冻结的供应商；
      // 指定品类的冻结 / 解冻不改供应商状态，只对合格供应商
      name: 'disposition_action_allowed',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '供应商当前状态不能执行这个处置动作',
      condition: { dialect: 'cel', source: allowedActions },
    },
    {
      name: 'disposition_action_allowed_on_submit',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '供应商当前状态不能执行这个处置动作',
      condition: { dialect: 'cel', source: `${submitting} && ${allowedActions}` },
    },
    {
      name: 'one_open_disposition',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '这家供应商已有审批中的处置单，审结后再发起',
      condition: { dialect: 'cel', source: `record.status != 'draft' && ${hasOpen}` },
    },
    {
      name: 'one_open_disposition_on_submit',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '这家供应商已有审批中的处置单，审结后再发起',
      condition: { dialect: 'cel', source: `${submitting} && ${hasOpen}` },
    },
  ],
});
