import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { SCORE_DAYS, gradeOf } from './params.js';

// P9 步骤 4–5（03 §10，FR-704）：考评单转审定中（全部评分完成或评分截止）时汇总分级，交采购总监审定发布。
//
// 汇总：total_score = Σ(score × weight)（启用指标权重合计 100%）；各维度得分为维度内按权重的加权平均（0–100，没有该维度
// 的指标时为空）；都保留两位小数，等级按两位小数的总分取参数 perf_grade_min（params.ts 的 GRADE_MIN）。
// 审定：position = srm_procurement_director（03 §12）。通过 → 已发布，写审定人、意见、发布日期，回写供应商 grade、
// latest_score（同一供应商已有更晚期间的已发布考评单时不回写，补跑旧期间不会覆盖最新结果），通知评分人。
// 驳回即「退回重评」：回到人工评分，审定意见写入 review_comment，截止日重新起算，通知评分人改分。只有一级审批，
// 所以不用平台的「退回修改」（考评单没有发起人可以重新提交）。
//
// 职责分离（同 BR-11）：审定人不能是本考评单的评分人。平台还没有「提交人不得审批」开关（objectstack#25446），
// 所以通过后由 flow 读审批记录比对，撞人时这次通过不算数，通知后重新开一轮审定（同 srm_disposition_approval）。
//
// 临时：CEL 没有对列表求和，加权合计只能逐行累加（07 §6.3 PF15，数据点记在 objectstack#14500）。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;
const round2 = (x: string) => `(double(round((${x}) * 100.0)) / 100.0)`;
const DIMENSIONS = ['quality', 'cost', 'delivery', 'service', 'hse'] as const;

// 维度内加权平均的累加器：<dim>W 为权重和，<dim>S 为得分 × 权重之和
const accumulators = Object.fromEntries(DIMENSIONS.flatMap((d) => [[`${d}W`, c('0.0')], [`${d}S`, c('0.0')]]));
const addLine = Object.fromEntries(
  DIMENSIONS.flatMap((d) => [
    [`${d}W`, c(`dim == '${d}' ? ${d}W + w : ${d}W`)],
    [`${d}S`, c(`dim == '${d}' ? ${d}S + sc * w : ${d}S`)],
  ]),
);
const dimensionScores = Object.fromEntries(DIMENSIONS.map((d) => [`${d}_score`, c(`${d}W > 0.0 ? ${round2(`${d}S / ${d}W`)} : null`)]));

export const PerformancePublishFlow: Automation.Flow = {
  name: 'srm_performance_publish',
  label: '绩效汇总分级与审定发布',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '考评单转审定中',
      config: {
        objectName: 'srm_performance_review',
        triggerType: 'record-after-write',
        condition: P`record.status == 'reviewing' && previous != null && has(previous.status) && previous.status != 'reviewing'`,
      },
    },
    {
      id: 'load_lines',
      type: 'get_record',
      label: '读取评分明细',
      config: {
        objectName: 'srm_performance_score',
        filter: { review: cel`record.id` },
        fields: ['kpi', 'weight', 'score', 'scorer'],
        limit: 500,
        outputVariable: 'lines',
      },
    },
    {
      id: 'load_kpis',
      type: 'get_record',
      label: '读取指标维度',
      config: {
        objectName: 'srm_kpi',
        filter: { id: { $in: cel`lines.map(l, l.kpi)` } },
        fields: ['id', 'dimension'],
        limit: 500,
        outputVariable: 'kpis',
      },
    },
    { id: 'reset', type: 'assignment', label: '累计清零', config: { assignments: { total: c('0.0'), scorers: c('[]'), ...accumulators } } },
    {
      id: 'sum_lines',
      type: 'loop',
      label: '累加加权得分',
      config: {
        collection: cel`lines`,
        iteratorVariable: 'line',
        body: {
          nodes: [
            {
              id: 'add_line',
              type: 'assignment',
              label: '累加',
              config: {
                assignments: {
                  dim: c(`kpis.exists(k, k.id == line.kpi) ? kpis.filter(k, k.id == line.kpi)[0].dimension : ''`),
                  sc: c(`${val('line.score')} ? double(line.score) : 0.0`),
                  w: c(`${val('line.weight')} ? double(line.weight) : 0.0`),
                  total: c('total + sc * w'),
                  ...addLine,
                  scorers: c(`${val('line.scorer')} && !(line.scorer in scorers) ? scorers + [line.scorer] : scorers`),
                },
              },
            },
          ],
        },
      },
    },
    {
      id: 'grade',
      type: 'assignment',
      label: '总分与等级',
      config: { assignments: { totalScore: c(round2('total')), gradeValue: c(gradeOf('totalScore')) } },
    },
    {
      id: 'write_scores',
      type: 'update_record',
      label: '写入各维度得分、总分与等级',
      config: {
        objectName: 'srm_performance_review',
        filter: { id: cel`record.id` },
        fields: { ...dimensionScores, total_score: cel`totalScore`, grade: cel`gradeValue` },
      },
    },

    // 采购总监审定
    {
      id: 'director_review',
      type: 'approval',
      label: '采购总监审定',
      config: {
        approvers: [{ type: 'position', value: 'srm_procurement_director' }],
        // 岗位没人时交给组织管理员，避免考评单卡在锁定状态
        onEmptyApprovers: 'admin_rescue',
        behavior: 'first_response',
        lockRecord: true,
        approvalStatusField: 'approval_status',
        maxRevisions: 0,
      },
    },
    {
      id: 'approve_action',
      type: 'get_record',
      label: '读取审定记录',
      config: { objectName: 'sys_approval_action', filter: { request_id: cel`director_review.requestId`, action: 'approve' }, outputVariable: 'approveAction' },
    },
    { id: 'sod', type: 'decision', label: '审定人是本考评单的评分人？' },
    {
      id: 'self',
      type: 'notify',
      label: '评分人不能审定本考评单',
      config: {
        recipients: cel`approveAction.actor_id`,
        title: '考评单 {{ record.review_no }} 需由另一位采购总监审定',
        message: '你是这张考评单的评分人，你的审定不计入，已重新提交给采购总监。',
        severity: 'warning',
        sourceObject: 'srm_performance_review',
        sourceId: cel`record.id`,
      },
    },
    {
      id: 'publish',
      type: 'update_record',
      label: '发布',
      config: {
        objectName: 'srm_performance_review',
        filter: { id: cel`record.id` },
        fields: {
          status: 'published',
          reviewer: cel`approveAction.actor_id`,
          review_comment: c(`${val('approveAction.comment')} && approveAction.comment != '' ? approveAction.comment : null`),
          published_date: cel`isoDate(today())`,
        },
      },
    },
    {
      id: 'load_later',
      type: 'get_record',
      label: '有更晚期间的已发布考评单？',
      config: {
        objectName: 'srm_performance_review',
        filter: { supplier: cel`record.supplier`, status: { $in: ['published', 'appealed'] }, period_end: { $gt: cel`record.period_end` } },
        fields: ['id'],
        outputVariable: 'later',
      },
    },
    { id: 'is_latest', type: 'decision', label: '是最近一期？' },
    {
      id: 'write_supplier',
      type: 'update_record',
      label: '回写供应商等级与总分',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { grade: cel`gradeValue`, latest_score: cel`totalScore` } },
    },
    { id: 'has_scorers', type: 'decision', label: '有评分人？' },
    {
      id: 'notify_published',
      type: 'notify',
      label: '通知评分人：已发布',
      config: {
        recipients: cel`scorers`,
        title: '考评单 {{ record.review_no }} 已发布',
        message: '期间 {{ record.period }} 的考评结果已由采购总监审定发布：总分 {{ totalScore }}。',
        sourceObject: 'srm_performance_review',
        sourceId: cel`record.id`,
      },
    },

    // 驳回：退回重评
    {
      id: 'reject_action',
      type: 'get_record',
      label: '读取退回意见',
      config: { objectName: 'sys_approval_action', filter: { request_id: cel`director_review.requestId`, action: 'reject' }, outputVariable: 'rejectAction' },
    },
    {
      id: 'back_to_scoring',
      type: 'update_record',
      label: '退回重评',
      config: {
        objectName: 'srm_performance_review',
        filter: { id: cel`record.id` },
        fields: {
          status: 'scoring',
          review_comment: c(`rejectAction != null && ${val('rejectAction.comment')} ? rejectAction.comment : null`),
          score_due: c(`isoDate(addDays(today(), ${SCORE_DAYS}))`),
        },
      },
    },
    { id: 'has_scorers_back', type: 'decision', label: '有评分人？' },
    {
      id: 'notify_back',
      type: 'notify',
      label: '通知评分人：退回重评',
      config: {
        recipients: cel`scorers`,
        title: '考评单 {{ record.review_no }} 退回重评',
        message: '采购总监退回了这张考评单，意见见考评单的「审定意见」。请在评分截止日前点「提交评分」修改你的评分项。',
        severity: 'warning',
        sourceObject: 'srm_performance_review',
        sourceId: cel`record.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_lines', type: 'default' },
    { id: 'e2', source: 'load_lines', target: 'load_kpis', type: 'default' },
    { id: 'e3', source: 'load_kpis', target: 'reset', type: 'default' },
    { id: 'e4', source: 'reset', target: 'sum_lines', type: 'default' },
    { id: 'e5', source: 'sum_lines', target: 'grade', type: 'default' },
    { id: 'e6', source: 'grade', target: 'write_scores', type: 'default' },
    { id: 'e7', source: 'write_scores', target: 'director_review', type: 'default' },

    { id: 'e_approve', source: 'director_review', target: 'approve_action', type: 'default', label: 'approve' },
    { id: 'e_reject', source: 'director_review', target: 'reject_action', type: 'default', label: 'reject' },
    { id: 'e8', source: 'approve_action', target: 'sod', type: 'default' },
    {
      id: 'e_self',
      source: 'sod',
      target: 'self',
      type: 'conditional',
      condition: c('approveAction.actor_id in scorers'),
      label: '审定人是评分人',
    },
    { id: 'e_ok', source: 'sod', target: 'publish', type: 'conditional', condition: c('!(approveAction.actor_id in scorers)'), label: '不是' },
    { id: 'e_again', source: 'self', target: 'director_review', type: 'back', label: '重新审定' },
    { id: 'e9', source: 'publish', target: 'load_later', type: 'default' },
    { id: 'e10', source: 'load_later', target: 'is_latest', type: 'default' },
    { id: 'e_latest', source: 'is_latest', target: 'write_supplier', type: 'conditional', condition: c('later == null'), label: '是' },
    { id: 'e_older', source: 'is_latest', target: 'has_scorers', type: 'conditional', condition: c('later != null'), label: '已有更晚的' },
    { id: 'e11', source: 'write_supplier', target: 'has_scorers', type: 'default' },
    { id: 'e_notify', source: 'has_scorers', target: 'notify_published', type: 'conditional', condition: c('scorers.size() > 0'), label: '有' },
    { id: 'e_quiet', source: 'has_scorers', target: 'end', type: 'conditional', condition: c('scorers.size() == 0'), label: '没有' },
    { id: 'e12', source: 'notify_published', target: 'end', type: 'default' },

    { id: 'e13', source: 'reject_action', target: 'back_to_scoring', type: 'default' },
    { id: 'e14', source: 'back_to_scoring', target: 'has_scorers_back', type: 'default' },
    { id: 'e_notify_back', source: 'has_scorers_back', target: 'notify_back', type: 'conditional', condition: c('scorers.size() > 0'), label: '有' },
    { id: 'e_quiet_back', source: 'has_scorers_back', target: 'end', type: 'conditional', condition: c('scorers.size() == 0'), label: '没有' },
    { id: 'e15', source: 'notify_back', target: 'end', type: 'default' },
  ],
};
