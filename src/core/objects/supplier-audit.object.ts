import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商审核（02 §4.2，03 §3 第 5 步，FR-607、FR-204；体系文件 WI-01）。SQE 新建准入审核、专项审核，
// 年度审核由 srm_audit_plan_generate 按物资类别生成「计划中」记录；审核后录入日期、总分、最低审核块得分、
// 结论，上传审核报告与评分表（QR-03），问题项在子表 srm_supplier_audit_finding 里登记，经「转整改单」
// （srm_audit_finding_to_scar）生成整改单。准入审核完成时 srm_audit_admission_apply 把结论写回准入申请。
// 结论分数线取 params/core.yaml 的 audit_score_thresholds（示例：通过 85 分，下限 70 分），客户改参数时同步这里。
//
// 检查表按设计是 repeater，但平台的 repeater 不能声明子字段（列名、类型、选项、翻译都没处写），表单只能当
// 无结构的表格编辑，问题项也无法回填整改单。所以逐条评分留在评分表附件里，系统记总分和最低审核块得分；
// 问题项改为子对象，可以单独查询、统计和关联整改单。
const celOf = (source: string) => ({ dialect: 'cel' as const, source });
const blank = (k: string) => `(!has(record.${k}) || record.${k} == null || isBlank(record.${k}))`;
const PASS = 85;
const FLOOR = 70;
const done = P`record.status == 'done'`;
// 分数没填按不达标处理；子表计数没有子记录时可能为空
const below = (k: string, line: number) => `(!has(record.${k}) || record.${k} == null || record.${k} < ${line})`;
const countAbove = (k: string, n: number) => `(has(record.${k}) && record.${k} != null && record.${k} > ${n})`;

export const SupplierAudit = ObjectSchema.create({
  name: 'srm_supplier_audit',
  label: '供应商审核',
  pluralLabel: '供应商审核',
  icon: 'clipboard-list',
  // 读靠权限集的 viewAllRecords。年度计划由系统生成，SQE 之间要互相接手：质量岗位改别人建的审核靠按岗位授 edit 的
  // 共享规则 srm_supplier_audit_edit_*（可改不可删，objectstack#25470 的裁定写法）；只有质量岗位有 allowEdit。
  // 审核记录不对供应商开放，门户上线后也不加 portal_position
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'audit_no',

  fieldGroups: [
    { key: 'plan', label: '审核计划', icon: 'calendar' },
    { key: 'result', label: '审核结论', icon: 'clipboard-check' },
  ],

  fields: {
    audit_no: Field.autonumber({ label: '审核编号', group: 'plan', autonumberFormat: 'AUD{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'plan',
      required: true,
      relatedListColumns: ['audit_no', 'audit_type', 'planned_date', 'audit_date', 'checklist_score', 'result', 'status'],
    }),
    audit_type: Field.select({
      label: '审核类型',
      group: 'plan',
      required: true,
      defaultValue: 'admission',
      options: [
        { label: '准入审核', value: 'admission' },
        { label: '年度审核', value: 'annual' },
        { label: '专项审核', value: 'special' },
      ],
    }),
    // 准入审核关联本次申请（03 §3 第 5 步）；结论由 srm_audit_admission_apply 写回申请
    application: Field.lookup('srm_supplier_application', {
      label: '准入申请',
      group: 'plan',
      requiredWhen: P`record.audit_type == 'admission'`,
      relatedListColumns: ['audit_no', 'audit_date', 'checklist_score', 'result', 'sample_result', 'status'],
    }),
    // 年度计划生成时写入，重复运行按「供应商 + 计划年度」不重复生成（03 §2.3 R2）
    plan_year: Field.number({ label: '计划年度', group: 'plan', readonly: true, scale: 0, useGrouping: false }),
    planned_date: Field.date({ label: '计划日期', group: 'plan', requiredWhen: P`record.status == 'planned'` }),
    auditors: Field.user({ label: '审核员', group: 'plan', multiple: true }),
    status: Field.select({
      label: '状态',
      group: 'plan',
      defaultValue: 'planned',
      options: [
        { label: '计划中', value: 'planned', kind: 'open' },
        { label: '已完成', value: 'done', kind: 'won' },
        { label: '已取消', value: 'cancelled', kind: 'lost' },
      ],
    }),
    // 取消原因：如 WI-01 6.9 不需要现场复审的 B 类供应商、经批准以资料审核代替一次复审
    cancel_reason: Field.textarea({ label: '取消原因', group: 'plan', requiredWhen: P`record.status == 'cancelled'` }),

    audit_date: Field.date({ label: '审核日期', group: 'result', requiredWhen: done }),
    // 审核总分 = Σ（审核块得分 × 权重），满分 100（WI-01 6.3.3）
    checklist_score: Field.number({ label: '审核总分', group: 'result', min: 0, max: 100, precision: 4, scale: 1, requiredWhen: done }),
    lowest_block_score: Field.number({ label: '最低审核块得分', group: 'result', min: 0, max: 100, precision: 4, scale: 1, requiredWhen: done }),
    result: Field.select({
      label: '审核结论',
      group: 'result',
      requiredWhen: done,
      options: [
        { label: '通过', value: 'pass' },
        { label: '有条件通过', value: 'conditional' },
        { label: '不通过', value: 'fail' },
      ],
    }),
    sample_result: Field.select({
      label: '样品检验结论',
      group: 'result',
      defaultValue: 'not_required',
      options: [
        { label: '不需要', value: 'not_required' },
        { label: '合格', value: 'pass' },
        { label: '不合格', value: 'fail' },
      ],
    }),
    report: Field.file({ label: '审核报告', group: 'result' }),
    scoresheet: Field.file({ label: '审核评分表', group: 'result' }),
    serious_finding_count: Field.summary({
      label: '严重不符合项数',
      group: 'result',
      summaryOperations: { object: 'srm_supplier_audit_finding', field: 'id', function: 'count', filter: { severity: 'serious' } },
    }),
    veto_finding_count: Field.summary({
      label: '否决项数',
      group: 'result',
      summaryOperations: { object: 'srm_supplier_audit_finding', field: 'id', function: 'count', filter: { veto: true } },
    }),
  },

  validations: [
    {
      name: 'audit_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '审核状态不允许这样变更',
      initialStates: ['planned', 'done'],
      transitions: {
        planned: ['done', 'cancelled'],
        cancelled: ['planned'],
        done: [],
      },
    },
    {
      // 引用字段为空时不读关联记录（规则读不到会拒绝写入）
      name: 'application_same_supplier_guard',
      type: 'conditional',
      message: '准入申请必须是本供应商的申请',
      when: P`has(record.application) && record.application != null`,
      then: {
        name: 'application_same_supplier',
        type: 'script',
        severity: 'error',
        message: '准入申请必须是本供应商的申请',
        condition: P`has(record.application.supplier) && record.application.supplier != record.supplier`,
      },
    },
    {
      // 已结束的申请不再需要审核结论
      name: 'application_in_progress_guard',
      type: 'conditional',
      events: ['insert'],
      message: '只能为进行中的准入申请安排准入审核',
      when: P`has(record.application) && record.application != null`,
      then: {
        name: 'application_in_progress',
        type: 'script',
        severity: 'error',
        message: '只能为进行中的准入申请安排准入审核',
        condition: P`has(record.application.status) && (record.application.status == 'approved' || record.application.status == 'rejected')`,
      },
    },
    {
      // 结论按分数线判定（WI-01 6.6.1）：系统只拦「高判」，审核组可以从严判定
      name: 'pass_meets_thresholds',
      type: 'script',
      severity: 'error',
      message: `「通过」要求总分 ≥ ${PASS} 分、每个审核块 ≥ ${FLOOR} 分，且没有严重不符合项和否决项`,
      condition: celOf(
        `record.result == 'pass' && (${below('checklist_score', PASS)} || ${below('lowest_block_score', FLOOR)}`
        + ` || ${countAbove('serious_finding_count', 0)} || ${countAbove('veto_finding_count', 0)})`,
      ),
    },
    {
      name: 'conditional_meets_thresholds',
      type: 'script',
      severity: 'error',
      message: `「有条件通过」要求总分 ≥ ${FLOOR} 分、严重不符合项不超过 1 项，且没有否决项`,
      condition: celOf(
        `record.result == 'conditional' && (${below('checklist_score', FLOOR)} || ${countAbove('serious_finding_count', 1)}`
        + ` || ${countAbove('veto_finding_count', 0)})`,
      ),
    },
    {
      name: 'cancel_reason_required',
      type: 'script',
      severity: 'error',
      message: '取消审核时需要填写原因',
      condition: celOf(`record.status == 'cancelled' && ${blank('cancel_reason')}`),
    },
  ],
});
