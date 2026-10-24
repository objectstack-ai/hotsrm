import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { gradeOf } from './params.js';

// 处理绩效申诉（03 §10 第 7 步，FR-706）：采购总监在申诉中的考评单上写处理结果，选择维持原结果或调整总分；调整时
// 等级按新总分取 perf_grade_min 重算（params.ts 的 GRADE_MIN），各评分明细与维度得分不变，处理结果里写明调整依据。
// 处理后回到已发布，处理人、结论和结果留在考评单上；是该供应商最近一期时同步回写供应商等级与总分；通知申诉代录人。
// 处理人不能是本考评单的评分人（同审定发布的职责分离）。以系统身份运行，进门检查在 flow 里做。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const round2 = (x: string) => `(double(round((${x}) * 100.0)) / 100.0)`;
const director = `current_user != null && 'srm_procurement_director' in current_user.positions`;
const appealed = `review != null && review.status == 'appealed'`;

export const AppealResolveFlow: Automation.Flow = {
  name: 'srm_appeal_resolve',
  label: '处理绩效申诉',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '申诉已处理，考评单回到已发布',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取考评单',
      config: { objectName: 'srm_performance_review', filter: { id: cel`recordId` }, outputVariable: 'review' },
    },
    { id: 'gate', type: 'decision', label: '可以处理？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是采购总监',
      config: { outcome: 'refused', message: '绩效申诉由采购总监处理' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不在申诉中',
      config: { outcome: 'refused', message: '只有申诉中的考评单需要处理申诉' },
    },
    {
      id: 'load_own',
      type: 'get_record',
      label: '本人是这张考评单的评分人？',
      config: { objectName: 'srm_performance_score', filter: { review: cel`review.id`, scorer: cel`current_user.id` }, fields: ['id'], outputVariable: 'own' },
    },
    { id: 'sod', type: 'decision', label: '评分人不能处理申诉' },
    {
      id: 'refuse_scorer',
      type: 'end',
      label: '评分人不能处理本考评单的申诉',
      config: { outcome: 'refused', message: '你是这张考评单的评分人，申诉请由另一位采购总监处理' },
    },
    {
      id: 'resolve',
      type: 'screen',
      label: '处理申诉',
      config: {
        title: '处理申诉：{{ review.review_no }}',
        description: '期间 {{ review.period }}，原总分 {{ review.total_score }}。\n申诉理由：{{ review.appeal_reason }}',
        fields: [
          {
            name: 'outcome',
            label: '处理结论',
            type: 'select',
            required: true,
            options: [
              { label: '维持原结果', value: 'maintained' },
              { label: '调整总分', value: 'adjusted' },
            ],
          },
          { name: 'adjusted_score', label: '调整后总分（0–100）', type: 'number', required: true, min: 0, max: 100, visibleWhen: "outcome == 'adjusted'" },
          { name: 'result_text', label: '处理结果', type: 'textarea', required: true },
        ],
      },
    },
    {
      id: 'regrade',
      type: 'assignment',
      label: '总分与等级',
      config: {
        assignments: {
          totalScore: c(`outcome == 'adjusted' ? ${round2('double(adjusted_score)')} : double(review.total_score)`),
          gradeValue: c(gradeOf('totalScore')),
        },
      },
    },
    {
      id: 'close',
      type: 'update_record',
      label: '回到已发布',
      config: {
        objectName: 'srm_performance_review',
        filter: { id: cel`review.id` },
        fields: {
          status: 'published',
          appeal_outcome: cel`outcome`,
          appeal_result: cel`result_text`,
          appeal_handled_by: cel`current_user.id`,
          total_score: cel`totalScore`,
          grade: cel`gradeValue`,
        },
      },
    },
    {
      id: 'load_later',
      type: 'get_record',
      label: '有更晚期间的已发布考评单？',
      config: {
        objectName: 'srm_performance_review',
        filter: { supplier: cel`review.supplier`, status: { $in: ['published', 'appealed'] }, period_end: { $gt: cel`review.period_end` } },
        fields: ['id'],
        outputVariable: 'later',
      },
    },
    { id: 'is_latest', type: 'decision', label: '是最近一期？' },
    {
      id: 'write_supplier',
      type: 'update_record',
      label: '回写供应商等级与总分',
      config: { objectName: 'srm_supplier', filter: { id: cel`review.supplier` }, fields: { grade: cel`gradeValue`, latest_score: cel`totalScore` } },
    },
    {
      id: 'notify',
      type: 'notify',
      label: '通知申诉代录人',
      config: {
        recipients: cel`has(review.appeal_recorded_by) && review.appeal_recorded_by != null ? review.appeal_recorded_by : null`,
        title: '考评单 {{ review.review_no }} 的申诉已处理',
        message: '采购总监已处理申诉，处理结果见考评单。请把结果告知供应商。',
        sourceObject: 'srm_performance_review',
        sourceId: cel`review.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${director})`), label: '不是采购总监' },
    { id: 'e3', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${director} && !(${appealed})`), label: '不在申诉中' },
    { id: 'e4', source: 'gate', target: 'load_own', type: 'conditional', condition: c(`${director} && ${appealed}`), label: '可以' },
    { id: 'e5', source: 'load_own', target: 'sod', type: 'default' },
    { id: 'e6', source: 'sod', target: 'refuse_scorer', type: 'conditional', condition: c('own != null'), label: '是评分人' },
    { id: 'e7', source: 'sod', target: 'resolve', type: 'conditional', condition: c('own == null'), label: '不是' },
    { id: 'e8', source: 'resolve', target: 'regrade', type: 'default' },
    { id: 'e9', source: 'regrade', target: 'close', type: 'default' },
    { id: 'e10', source: 'close', target: 'load_later', type: 'default' },
    { id: 'e11', source: 'load_later', target: 'is_latest', type: 'default' },
    { id: 'e_latest', source: 'is_latest', target: 'write_supplier', type: 'conditional', condition: c('later == null'), label: '是' },
    { id: 'e_older', source: 'is_latest', target: 'notify', type: 'conditional', condition: c('later != null'), label: '已有更晚的' },
    { id: 'e12', source: 'write_supplier', target: 'notify', type: 'default' },
    { id: 'e13', source: 'notify', target: 'end', type: 'default' },
  ],
};
