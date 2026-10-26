import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { SrmPositions } from '../../security/positions.js';

// 改派评分人（03 §10 第 3 步，GL-06 6.4.5、GL-05 6.3 与附录 B）：考评单生成后才发现评分人与被评价供应商存在关联关系或其他
// 利益冲突的，由采购总监（采购部负责人）在人工评分中的考评单的评分项上点「改派评分人」，选替代人员并写明回避原因。
// 评分人在生成时写入，考评单与评分明细对所有内部岗位只读，所以改派以系统身份运行，进门检查在 flow 里做（同 srm_performance_void）。
// 改派后原评分人的分数和说明作废（scored 置回 false），由替代人员经「提交评分」重新评分；评分截止日不变。原评分人、改派人、
// 原因和日期留在评分项上；替代人员不能是原评分人或改派人自己，且要有内部岗位。自动算出得分的评分项没有评分人，不能改派。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;
// 能评分的内部岗位：挂 srm_internal_base 的岗位（内控 / 监标不评分）
const internal = SrmPositions.filter((p) => p.permissionSets.includes('srm_internal_base')).map((p) => `'${p.name}'`).join(', ');

const director = `current_user != null && 'srm_procurement_director' in current_user.positions`;
const scoring = `review != null && review.status == 'scoring'`;
// 人工评分项：有评分人、还没评分（没有数据的自动指标、没指派到人的），或截止时取了默认分的
const manual = `line != null && (${val('line.scorer')} || line.scored == false || line.defaulted == true)`;
const oldScorer = `${val('line.scorer')} ? line.scorer : null`;

export const ScoreReassignFlow: Automation.Flow = {
  name: 'srm_score_reassign',
  label: '改派评分人',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '评分项已改派，已通知替代评分人',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load_line',
      type: 'get_record',
      label: '读取评分项',
      config: { objectName: 'srm_performance_score', filter: { id: cel`recordId` }, outputVariable: 'line' },
    },
    {
      id: 'load',
      type: 'get_record',
      label: '读取考评单',
      config: { objectName: 'srm_performance_review', filter: { id: c('line != null ? line.review : null') }, outputVariable: 'review' },
    },
    { id: 'gate', type: 'decision', label: '可以改派？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是采购总监',
      config: { outcome: 'refused', message: '评分人回避的改派由采购总监指定替代人员' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不在人工评分',
      config: { outcome: 'refused', message: '只有人工评分中的考评单可以改派评分人；审定中的先退回重评' },
    },
    {
      id: 'refuse_auto',
      type: 'end',
      label: '自动算分的评分项',
      config: { outcome: 'refused', message: '这一项由系统按交付记录自动算分，没有评分人' },
    },
    {
      id: 'load_info',
      type: 'get_record',
      label: '读取指标',
      config: { objectName: 'srm_kpi', filter: { id: cel`line.kpi` }, fields: ['name'], outputVariable: 'kpi' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`review.supplier` }, fields: ['name'], outputVariable: 'vendor' },
    },
    { id: 'has_scorer', type: 'decision', label: '有原评分人？' },
    {
      id: 'load_scorer',
      type: 'get_record',
      label: '读取原评分人',
      config: { objectName: 'sys_user', filter: { id: cel`line.scorer` }, fields: ['name'], outputVariable: 'scorerUser' },
    },
    {
      id: 'name_scorer',
      type: 'assignment',
      label: '原评分人姓名',
      config: { assignments: { scorerText: c(`scorerUser != null && ${val('scorerUser.name')} ? scorerUser.name : '—'`) } },
    },
    { id: 'name_none', type: 'assignment', label: '生成时未指派', config: { assignments: { scorerText: c(`'未指派'`) } } },
    {
      id: 'texts',
      type: 'assignment',
      label: '整理显示内容',
      config: {
        assignments: {
          scoredText: c(`line.scored == true ? '已评分，改派后原分数作废，由替代人员重新评分' : '尚未评分'`),
        },
      },
    },
    {
      id: 'pick',
      type: 'screen',
      label: '选择替代人员',
      config: {
        title: '改派评分人：{{ kpi.name }}',
        description:
          '考评单：{{ review.review_no }}　供应商：{{ vendor.name }}　期间：{{ review.period }}\n'
          + '原评分人：{{ scorerText }}（{{ scoredText }}）　评分截止日：{{ review.score_due }}',
        fields: [
          { name: 'new_scorer', label: '替代评分人', type: 'lookup', reference: 'sys_user', required: true },
          { name: 'reason_text', label: '回避原因', type: 'textarea', required: true },
        ],
      },
    },
    {
      id: 'load_target',
      type: 'get_record',
      label: '读取替代人员的岗位',
      config: { objectName: 'sys_user_position', filter: { user_id: cel`new_scorer` }, limit: 50, outputVariable: 'targetPositions' },
    },
    { id: 'check', type: 'decision', label: '替代人员合适？' },
    {
      id: 'refuse_same',
      type: 'end',
      label: '还是原评分人',
      config: { outcome: 'refused', message: '替代评分人不能是原评分人' },
    },
    {
      id: 'refuse_self',
      type: 'end',
      label: '改派给自己',
      config: { outcome: 'refused', message: '不能把评分项改派给自己，请指定其他人员' },
    },
    {
      id: 'refuse_target',
      type: 'end',
      label: '替代人员没有内部岗位',
      config: { outcome: 'refused', message: '替代评分人必须是有 SRM 内部岗位的人员' },
    },
    {
      id: 'reassign',
      type: 'update_record',
      label: '改派评分项',
      config: {
        objectName: 'srm_performance_score',
        filter: { id: cel`line.id` },
        fields: {
          scorer: cel`new_scorer`,
          reassigned_from: c(oldScorer),
          reassigned_by: cel`current_user.id`,
          reassign_reason: cel`reason_text`,
          reassigned_date: cel`isoDate(today())`,
          score: null,
          // 没评过分的（没有数据的自动指标）保留生成时写的说明，评过的说明随分数作废
          comment: c(`line.scored == false && ${val('line.comment')} ? line.comment : null`),
          scored: false,
          defaulted: false,
        },
      },
    },
    {
      id: 'notify_new',
      type: 'notify',
      label: '通知替代评分人',
      config: {
        recipients: [cel`new_scorer`],
        title: '考评单 {{ review.review_no }} 有一项改派给你评分',
        message: '供应商 {{ vendor.name }} 期间 {{ review.period }} 的「{{ kpi.name }}」改派给你评分，请在 {{ review.score_due }} 前在考评单上点「提交评分」。',
        severity: 'warning',
        sourceObject: 'srm_performance_review',
        sourceId: cel`review.id`,
      },
    },
    { id: 'has_old', type: 'decision', label: '有原评分人？' },
    {
      id: 'notify_old',
      type: 'notify',
      label: '通知原评分人',
      config: {
        recipients: [cel`line.scorer`],
        title: '考评单 {{ review.review_no }} 的一项已改派他人评分',
        message: '供应商 {{ vendor.name }} 期间 {{ review.period }} 的「{{ kpi.name }}」已按回避要求改派给其他人员评分，你不再需要评这一项。',
        severity: 'info',
        sourceObject: 'srm_performance_review',
        sourceId: cel`review.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load_line', type: 'default' },
    { id: 'e1', source: 'load_line', target: 'load', type: 'default' },
    { id: 'e2', source: 'load', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${director})`), label: '不是采购总监' },
    { id: 'e4', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${director} && !(${scoring})`), label: '不在人工评分' },
    {
      id: 'e5',
      source: 'gate',
      target: 'refuse_auto',
      type: 'conditional',
      condition: c(`${director} && ${scoring} && !(${manual})`),
      label: '自动算分',
    },
    { id: 'e6', source: 'gate', target: 'load_info', type: 'conditional', condition: c(`${director} && ${scoring} && ${manual}`), label: '可以' },
    { id: 'e7', source: 'load_info', target: 'load_supplier', type: 'default' },
    { id: 'e8', source: 'load_supplier', target: 'has_scorer', type: 'default' },
    { id: 'e8a', source: 'has_scorer', target: 'load_scorer', type: 'conditional', condition: c(val('line.scorer')), label: '有' },
    { id: 'e8b', source: 'has_scorer', target: 'name_none', type: 'conditional', condition: c(`!${val('line.scorer')}`), label: '没有' },
    { id: 'e9', source: 'load_scorer', target: 'name_scorer', type: 'default' },
    { id: 'e9a', source: 'name_scorer', target: 'texts', type: 'default' },
    { id: 'e9b', source: 'name_none', target: 'texts', type: 'default' },
    { id: 'e10', source: 'texts', target: 'pick', type: 'default' },
    { id: 'e11', source: 'pick', target: 'load_target', type: 'default' },
    { id: 'e12', source: 'load_target', target: 'check', type: 'default' },
    {
      id: 'e13',
      source: 'check',
      target: 'refuse_same',
      type: 'conditional',
      condition: c(`${val('line.scorer')} && new_scorer == line.scorer`),
      label: '原评分人',
    },
    {
      id: 'e14',
      source: 'check',
      target: 'refuse_self',
      type: 'conditional',
      condition: c(`!(${val('line.scorer')} && new_scorer == line.scorer) && new_scorer == current_user.id`),
      label: '自己',
    },
    {
      id: 'e15',
      source: 'check',
      target: 'refuse_target',
      type: 'conditional',
      condition: c(
        `!(${val('line.scorer')} && new_scorer == line.scorer) && new_scorer != current_user.id`
        + ` && !targetPositions.exists(p, p.position in [${internal}])`,
      ),
      label: '没有内部岗位',
    },
    {
      id: 'e16',
      source: 'check',
      target: 'reassign',
      type: 'conditional',
      condition: c(
        `!(${val('line.scorer')} && new_scorer == line.scorer) && new_scorer != current_user.id`
        + ` && targetPositions.exists(p, p.position in [${internal}])`,
      ),
      label: '可以',
    },
    { id: 'e17', source: 'reassign', target: 'notify_new', type: 'default' },
    { id: 'e18', source: 'notify_new', target: 'has_old', type: 'default' },
    { id: 'e19', source: 'has_old', target: 'notify_old', type: 'conditional', condition: c(val('line.scorer')), label: '有' },
    { id: 'e20', source: 'has_old', target: 'end', type: 'conditional', condition: c(`!${val('line.scorer')}`), label: '没有' },
    { id: 'e21', source: 'notify_old', target: 'end', type: 'default' },
  ],
};
