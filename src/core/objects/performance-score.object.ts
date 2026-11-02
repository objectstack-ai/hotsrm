import { ObjectSchema, Field } from '@objectstack/spec/data';

// 评分明细（02 §4.7，FR-702）：考评生成时按指标库中启用的指标各建一行，权重从指标快照过来，之后改指标库不影响
// 已生成的考评单。自动指标由生成 flow 写入原始值与得分；人工指标和没有数据的自动指标由生成时指派的评分人经「提交评分」
// screen flow 打分（v0.5 P3），截止后未评的取默认分并标记「未评」。评分人需要回避的，由采购总监经「改派评分人」screen flow
// 改派给替代人员（#65），原评分人、改派人、原因和日期记在评分项上。
// 原始值与指标的满分值、零分值同一单位：比率按百分点（98 即 98%），PPM 按 PPM。
export const PerformanceScore = ObjectSchema.create({
  name: 'srm_performance_score',
  label: '评分明细',
  pluralLabel: '评分明细',
  icon: 'list-checks',
  sharingModel: 'controlled_by_parent',

  fields: {
    review: Field.masterDetail('srm_performance_review', {
      label: '考评单',
      required: true,
      deleteBehavior: 'cascade',
      relatedListColumns: ['kpi', 'weight', 'raw_value', 'score', 'scored', 'defaulted', 'scorer', 'comment'],
    }),
    kpi: Field.lookup('srm_kpi', { label: '指标', required: true, readonly: true }),
    weight: Field.percent({ label: '权重', readonly: true, min: 0, max: 1 }),
    raw_value: Field.number({ label: '原始值', readonly: true, scale: 2 }),
    score: Field.number({ label: '得分', min: 0, max: 100, scale: 2 }),
    scorer: Field.user({ label: '评分人' }),
    comment: Field.textarea({ label: '评分说明', maxLength: 2000 }),
    scored: Field.boolean({ label: '已评分', defaultValue: false }),
    // 「未评」：评分截止时还没有评分，由 srm_score_overdue_sweep 取参数 perf_missing_score 的默认分（FR-703）
    defaulted: Field.boolean({ label: '未评（默认分）', defaultValue: false }),
    // 回避改派（srm_score_reassign，GL-06 6.4.5）：最近一次改派前的评分人、改派人、回避原因和日期，flow 写入
    reassigned_from: Field.user({ label: '原评分人', readonly: true }),
    reassigned_by: Field.user({ label: '改派人', readonly: true }),
    reassign_reason: Field.textarea({ label: '回避原因', readonly: true, maxLength: 2000 }),
    reassigned_date: Field.date({ label: '改派日期', readonly: true }),
  },
});
