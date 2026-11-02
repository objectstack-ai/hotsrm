import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 考评单上的按钮（03 §10 第 3、5、7 步）。谁能操作、能不能操作由 flow 自己检查。
const action = (name: string, label: string, icon: string, status: string) =>
  defineAction({
    name,
    label,
    objectName: 'srm_performance_review',
    icon,
    type: 'flow',
    target: name,
    locations: ['record_header'],
    visible: P`record.status == ${status}`,
    refreshAfter: true,
  });

export const ScoreSubmitAction = action('srm_score_submit', '提交评分', 'pencil', 'scoring');
export const PerformanceVoidAction = action('srm_performance_void', '作废', 'x-circle', 'scoring');
export const AppealSubmitAction = action('srm_appeal_submit', '申诉', 'message-square', 'published');
export const AppealResolveAction = action('srm_appeal_resolve', '处理申诉', 'gavel', 'appealed');

// 评分项上的按钮（考评单的评分明细列表每行，及评分项详情页）：回避改派评分人，自动算出得分的项不显示
export const ScoreReassignAction = defineAction({
  name: 'srm_score_reassign',
  label: '改派评分人',
  objectName: 'srm_performance_score',
  icon: 'user-round-cog',
  type: 'flow',
  target: 'srm_score_reassign',
  locations: ['record_related', 'record_header'],
  visible: P`record.scorer != null || record.scored == false || record.defaulted == true`,
  refreshAfter: true,
});
