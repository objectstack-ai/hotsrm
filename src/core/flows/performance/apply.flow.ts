import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { AUTO_APPLY, D_EXIT_PERIODS } from './params.js';

// P9 步骤 6 结果应用（03 §10，FR-705，BR-18）：考评单审定发布（审定中 → 已发布）后按等级准备后续动作。
// - C 级：开一张整改单（source = performance），负责 SQE 取供应商品类上的 SQE（物资类别高的优先），没有时通知质量经理指派；
// - D 级：生成冻结（全部品类）处置单草稿；同一供应商同一周期类型的已发布考评单往前逐期相邻、连续 perf_d_exit_periods
//   期（含本期）都是 D 级时改为生成淘汰处置单草稿（BR-18）。草稿只建不提交，由品类经理核实后「提交审批」或「作废」，
//   审批链沿用处置单审批（03 §5、§12）。冻结草稿只对合格供应商，淘汰草稿对合格或冻结的供应商；已有审批中的处置单时
//   只通知；已有同动作的草稿时不再建，通知品类经理处理那张草稿（同 srm_risk_event_apply）；
// - A 级的「优选」与等级一起由 srm_performance_publish / srm_appeal_resolve 写到供应商上，这里不处理 A、B 级。
// 只在审定发布时触发：申诉处理回到已发布（申诉中 → 已发布）不触发，申诉改变等级时由品类经理按通知核对原来的草稿和整改单
// （srm_appeal_resolve）。整改单与草稿都记下来源考评单（performance_review），重复触发不重复建。
// 参数 perf_auto_apply 关闭时（07 D9「首年可以只发布不自动处置」）只通知品类经理，不开整改单、不建草稿。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;

const published = `record.status == 'published' && previous != null && has(previous.status) && previous.status == 'reviewing'`;
const gradeCD = `${val('record.grade')} && (record.grade == 'grade_c' || record.grade == 'grade_d')`;

// 供应商各品类的品类经理；一个都没有时通知全部品类经理（同 srm_risk_event_apply）
const managers =
  `(size(categories.filter(c, has(c.category_manager) && c.category_manager != null)) > 0`
  + ` ? categories.filter(c, has(c.category_manager) && c.category_manager != null).map(c, c.category_manager)`
  + ` : allManagers.map(p, p.user_id))`;

// 整改单的负责 SQE：供应商品类上的 SQE，物资类别高的优先
const withSqe = `categories.filter(c, has(c.sqe) && c.sqe != null)`;
const sqeOf = (cls: string) => `${withSqe}.exists(c, c.material_class == '${cls}') ? ${withSqe}.filter(c, c.material_class == '${cls}')[0].sqe`;
const pickSqe = `${sqeOf('class_a')} : ${sqeOf('class_b')} : ${sqeOf('class_c')} : size(${withSqe}) > 0 ? ${withSqe}[0].sqe : null`;

const dimensionText = [
  ['quality', '质量'],
  ['cost', '成本'],
  ['delivery', '交付'],
  ['service', '服务'],
  ['hse', '安全环保'],
]
  .map(([d, label]) => `(${val(`record.${d}_score`)} ? '，${label} ' + string(record.${d}_score) : '')`)
  .join(' + ');

// 连续 D 级：从本期往前找紧挨着的上一期（上一期 period_end + 1 天 = 这一期 period_start），逐期看是不是 D 级。
// 缺一期（没有生成、已作废）就断开。逐期展开成同一个赋值节点里的顺序赋值，不用循环
// chain<i> = 往前 i 期都是 D 级，cursor<i> = 第 i 期的开始日
const streakSteps = Object.fromEntries(
  Array.from({ length: D_EXIT_PERIODS - 1 }, (_, k) => k + 1).flatMap((i) => [
    [`prev${i}`, c(`history.filter(h, string(h.period_end) == isoDate(addDays(cursor${i - 1}, -1)))`)],
    [`chain${i}`, c(`chain${i - 1} && prev${i}.exists(h, has(h.grade) && h.grade == 'grade_d')`)],
    [`cursor${i}`, c(`chain${i} ? string(prev${i}[0].period_start) : cursor${i - 1}`)],
  ]),
);
const canDraft =
  `vendor != null && (!has(vendor.open_disposition_count) || vendor.open_disposition_count == 0)`
  + ` && (action == 'freeze' ? vendor.status == 'qualified' : (vendor.status == 'qualified' || vendor.status == 'frozen'))`;

const guarded = (id: string, label: string, config: Record<string, unknown>) => ({
  id: `${id}_guard`,
  type: 'try_catch' as const,
  label,
  config: {
    try: { nodes: [{ id, type: 'notify' as const, label, config }] },
    // 没有可通知的人时不影响整改单和草稿
    catch: { nodes: [{ id: `${id}_skip`, type: 'assignment' as const, label: '跳过通知' }] },
  },
});

const loads = [
  {
    id: 'start',
    type: 'start' as const,
    label: '考评单审定发布为 C、D 级',
    config: { objectName: 'srm_performance_review', triggerType: 'record-after-write' as const, condition: c(`${published} && ${gradeCD}`) },
  },
  {
    id: 'load_supplier',
    type: 'get_record' as const,
    label: '读取供应商',
    config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'vendor' },
  },
  {
    id: 'load_qualifications',
    type: 'get_record' as const,
    label: '读取品类资格',
    config: { objectName: 'srm_supplier_category', filter: { supplier: cel`record.supplier` }, limit: 200, outputVariable: 'qualifications' },
  },
  {
    id: 'load_categories',
    type: 'get_record' as const,
    label: '读取品类',
    config: { objectName: 'srm_category', filter: { id: { $in: cel`qualifications.map(q, q.category)` } }, limit: 200, outputVariable: 'categories' },
  },
  {
    id: 'load_all_managers',
    type: 'get_record' as const,
    label: '读取全部品类经理',
    config: { objectName: 'sys_user_position', filter: { position: 'srm_category_manager' }, limit: 50, outputVariable: 'allManagers' },
  },
  {
    id: 'texts',
    type: 'assignment' as const,
    label: '通知用的等级与总分',
    config: {
      assignments: {
        gradeText: c(`record.grade == 'grade_c' ? 'C' : 'D'`),
        scoreText: c(`${val('record.total_score')} ? string(record.total_score) : '-'`),
        vendorName: c(`vendor != null ? vendor.name : ''`),
      },
    },
  },
];
const loadEdges = [
  { id: 'e1', source: 'start', target: 'load_supplier', type: 'default' as const },
  { id: 'e2', source: 'load_supplier', target: 'load_qualifications', type: 'default' as const },
  { id: 'e3', source: 'load_qualifications', target: 'load_categories', type: 'default' as const },
  { id: 'e4', source: 'load_categories', target: 'load_all_managers', type: 'default' as const },
  { id: 'e5', source: 'load_all_managers', target: 'texts', type: 'default' as const },
];
const end = { id: 'end', type: 'end' as const, label: '结束' };

// perf_auto_apply 关闭：只通知品类经理
const notifyOnly = (): Automation.Flow['nodes'] => [
  ...loads,
  guarded('notify_off', '通知品类经理：结果未自动应用', {
    recipients: c(managers),
    title: '考评单 {{ record.review_no }}：绩效 {{ gradeText }} 级',
    message:
      '{{ vendorName }} 期间 {{ record.period }} 的考评结果已发布：总分 {{ scoreText }}，{{ gradeText }} 级。绩效结果自动应用已关闭，'
      + '系统没有开整改单或生成处置单草稿，请按制度评估改善或处置。',
    severity: 'warning',
    sourceObject: 'srm_performance_review',
    sourceId: cel`record.id`,
  }),
  end,
];

const applyNodes = (): Automation.Flow['nodes'] => [
  ...loads,
  { id: 'by_grade', type: 'decision', label: '等级？' },

  // C 级：整改单
  {
    id: 'find_scar',
    type: 'get_record',
    label: '已开过整改单？',
    config: { objectName: 'srm_quality_issue', filter: { performance_review: cel`record.id` }, fields: ['id'], outputVariable: 'existingScar' },
  },
  { id: 'has_scar', type: 'decision', label: '已开过？' },
  {
    id: 'load_quality_managers',
    type: 'get_record',
    label: '读取质量经理',
    config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
  },
  { id: 'pick_sqe', type: 'assignment', label: '负责 SQE', config: { assignments: { sqePick: c(pickSqe) } } },
  {
    id: 'create_scar',
    type: 'create_record',
    label: '开绩效改善整改单',
    config: {
      objectName: 'srm_quality_issue',
      fields: {
        supplier: cel`record.supplier`,
        performance_review: cel`record.id`,
        source: 'performance',
        severity: 'minor',
        problem_description: c(
          `'绩效考评 ' + record.review_no + '（期间 ' + record.period + '）总分 ' + scoreText + '，C 级' + ${dimensionText}`
          + ` + '。请供应商针对失分项分析原因并提交改善措施。'`,
        ),
        sqe: c('sqePick'),
      },
      outputVariable: 'scar',
    },
  },
  guarded('notify_scar', '通知 SQE 与品类经理：已开整改单', {
    recipients: c(`${managers} + (sqePick != null ? [sqePick] : qualityManagers.map(p, p.user_id))`),
    title: '考评单 {{ record.review_no }}：绩效 C 级，已开整改单',
    message:
      '{{ vendorName }} 期间 {{ record.period }} 的考评结果为 C 级（总分 {{ scoreText }}），系统已开出绩效改善整改单。'
      + '请联系供应商在期限内提交改善措施；品类没有 SQE 时请质量经理指派。',
    severity: 'warning',
    sourceObject: 'srm_quality_issue',
    sourceId: cel`scar.id`,
  }),

  // D 级：冻结或淘汰草稿
  {
    id: 'load_history',
    type: 'get_record',
    label: '读取以前各期的已发布考评单',
    config: {
      objectName: 'srm_performance_review',
      filter: {
        supplier: cel`record.supplier`,
        cycle: cel`record.cycle`,
        status: { $in: ['published', 'appealed'] },
        period_end: { $lt: cel`record.period_start` },
      },
      fields: ['period_start', 'period_end', 'grade'],
      limit: 500,
      outputVariable: 'history',
    },
  },
  {
    id: 'streak',
    type: 'assignment',
    label: `连续 ${D_EXIT_PERIODS} 期 D 级？`,
    config: {
      assignments: {
        chain0: c('true'),
        cursor0: c('string(record.period_start)'),
        ...streakSteps,
        chain: c(`chain${D_EXIT_PERIODS - 1}`),
        action: c(`chain ? 'eliminate' : 'freeze'`),
        actionText: c(`chain ? '淘汰' : '冻结（全部品类）'`),
        streakText: c(`chain ? '，已连续 ${D_EXIT_PERIODS} 期 D 级' : ''`),
      },
    },
  },
  { id: 'can_draft', type: 'decision', label: '可以生成草稿？' },
  {
    id: 'find_draft',
    type: 'get_record',
    label: '已有同动作的草稿？',
    config: {
      objectName: 'srm_supplier_disposition',
      filter: { supplier: cel`record.supplier`, status: 'draft', action: cel`action` },
      fields: ['id'],
      outputVariable: 'existingDraft',
    },
  },
  { id: 'has_draft', type: 'decision', label: '已有草稿？' },
  {
    id: 'create_draft',
    type: 'create_record',
    label: '生成处置单草稿',
    config: {
      objectName: 'srm_supplier_disposition',
      fields: {
        supplier: cel`record.supplier`,
        action: cel`action`,
        scope: 'all',
        status: 'draft',
        performance_review: cel`record.id`,
        reason: c(
          `(chain ? '连续 ${D_EXIT_PERIODS} 期绩效 D 级' : '绩效 D 级') + '：考评单 ' + record.review_no + '（期间 ' + record.period + '）总分 ' + scoreText + ${dimensionText}`,
        ),
      },
      outputVariable: 'draft',
    },
  },
  { id: 'new_draft', type: 'assignment', label: '草稿', config: { assignments: { draftId: c('draft.id') } } },
  { id: 'old_draft', type: 'assignment', label: '已有的草稿', config: { assignments: { draftId: c('existingDraft.id') } } },
  guarded('notify_draft', '通知品类经理：处置单草稿', {
    recipients: c(managers),
    title: '考评单 {{ record.review_no }}：绩效 D 级，请核实{{ actionText }}处置单草稿',
    message:
      '{{ vendorName }} 期间 {{ record.period }} 的考评结果为 D 级（总分 {{ scoreText }}{{ streakText }}），{{ actionText }}处置单草稿已准备好。'
      + '请核实后在处置单上「提交审批」，不需要处置时「作废」。',
    severity: 'warning',
    sourceObject: 'srm_supplier_disposition',
    sourceId: cel`draftId`,
  }),
  guarded('notify_no_draft', '通知品类经理：未生成草稿', {
    recipients: c(managers),
    title: '考评单 {{ record.review_no }}：绩效 D 级，请评估处置',
    message:
      '{{ vendorName }} 期间 {{ record.period }} 的考评结果为 D 级（总分 {{ scoreText }}{{ streakText }}）。供应商当前状态不能{{ actionText }}或已有审批中的处置单，'
      + '系统没有生成草稿，请评估是否需要其他处置。',
    severity: 'warning',
    sourceObject: 'srm_performance_review',
    sourceId: cel`record.id`,
  }),
  end,
];

const applyEdges: Automation.Flow['edges'] = [
  ...loadEdges,
  { id: 'e6', source: 'texts', target: 'by_grade', type: 'default' },
  { id: 'e_c', source: 'by_grade', target: 'find_scar', type: 'conditional', condition: P`record.grade == 'grade_c'`, label: 'C 级' },
  { id: 'e_d', source: 'by_grade', target: 'load_history', type: 'conditional', condition: P`record.grade == 'grade_d'`, label: 'D 级' },

  { id: 'e7', source: 'find_scar', target: 'has_scar', type: 'default' },
  { id: 'e_scar_dup', source: 'has_scar', target: 'end', type: 'conditional', condition: P`existingScar != null`, label: '已开过' },
  { id: 'e_scar_new', source: 'has_scar', target: 'load_quality_managers', type: 'conditional', condition: P`existingScar == null`, label: '没有' },
  { id: 'e8', source: 'load_quality_managers', target: 'pick_sqe', type: 'default' },
  { id: 'e9', source: 'pick_sqe', target: 'create_scar', type: 'default' },
  { id: 'e10', source: 'create_scar', target: 'notify_scar_guard', type: 'default' },
  { id: 'e11', source: 'notify_scar_guard', target: 'end', type: 'default' },

  { id: 'e12', source: 'load_history', target: 'streak', type: 'default' },
  { id: 'e13', source: 'streak', target: 'can_draft', type: 'default' },
  { id: 'e_yes', source: 'can_draft', target: 'find_draft', type: 'conditional', condition: c(canDraft), label: '可以' },
  { id: 'e_no', source: 'can_draft', target: 'notify_no_draft_guard', type: 'conditional', condition: c(`!(${canDraft})`), label: '不能' },
  { id: 'e14', source: 'find_draft', target: 'has_draft', type: 'default' },
  // 同一张考评单已经生成过草稿时也走这里（重复触发不重复建）
  { id: 'e_new', source: 'has_draft', target: 'create_draft', type: 'conditional', condition: P`existingDraft == null`, label: '没有' },
  { id: 'e_old', source: 'has_draft', target: 'old_draft', type: 'conditional', condition: P`existingDraft != null`, label: '已有' },
  { id: 'e15', source: 'create_draft', target: 'new_draft', type: 'default' },
  { id: 'e16', source: 'new_draft', target: 'notify_draft_guard', type: 'default' },
  { id: 'e17', source: 'old_draft', target: 'notify_draft_guard', type: 'default' },
  { id: 'e18', source: 'notify_draft_guard', target: 'end', type: 'default' },
  { id: 'e19', source: 'notify_no_draft_guard', target: 'end', type: 'default' },
];

const notifyOnlyEdges: Automation.Flow['edges'] = [
  ...loadEdges,
  { id: 'e6', source: 'texts', target: 'notify_off_guard', type: 'default' },
  { id: 'e7', source: 'notify_off_guard', target: 'end', type: 'default' },
];

// 按开关生成 flow；测试用 autoApply = false 的版本验证开关关闭时的行为
export const performanceApplyFlow = (autoApply: boolean): Automation.Flow => ({
  name: 'srm_performance_apply',
  label: '绩效结果应用',
  type: 'record_change',
  status: 'active',
  runAs: 'system',
  nodes: autoApply ? applyNodes() : notifyOnly(),
  edges: autoApply ? applyEdges : notifyOnlyEdges,
});

export const PerformanceApplyFlow = performanceApplyFlow(AUTO_APPLY);
