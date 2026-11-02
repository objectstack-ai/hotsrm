import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { SCORE_REMINDER_DAYS } from './params.js';

// 评分截止提醒（03 §10 第 3 步）：人工评分中的考评单在评分截止日前 3 天（params.ts 的 SCORE_REMINDER_DAYS），
// 提醒还有未评项的评分人。平台按天扫描、每张考评单只发一次（time_relative 触发）；截止后的缺评由
// srm_score_overdue_sweep 处理。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;

export const ScoreDueNoticeFlow: Automation.Flow = {
  name: 'srm_score_due_notice',
  label: '绩效评分截止提醒',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: `截止前 ${SCORE_REMINDER_DAYS} 天`,
      config: {
        timeRelative: { object: 'srm_performance_review', dateField: 'score_due', offsetDays: [SCORE_REMINDER_DAYS], filter: { status: 'scoring' } },
      },
    },
    {
      id: 'load_pending',
      type: 'get_record',
      label: '读取未评项',
      config: {
        objectName: 'srm_performance_score',
        filter: { review: cel`record.id`, scored: false },
        fields: ['scorer'],
        limit: 500,
        outputVariable: 'pending',
      },
    },
    { id: 'reset', type: 'assignment', label: '评分人清单', config: { assignments: { scorers: c('[]') } } },
    {
      id: 'collect',
      type: 'loop',
      label: '去重评分人',
      config: {
        collection: cel`pending`,
        iteratorVariable: 'line',
        body: {
          nodes: [
            {
              id: 'add_scorer',
              type: 'assignment',
              label: '记下评分人',
              config: { assignments: { scorers: c(`${val('line.scorer')} && !(line.scorer in scorers) ? scorers + [line.scorer] : scorers`) } },
            },
          ],
        },
      },
    },
    { id: 'has_scorers', type: 'decision', label: '有未评的评分人？' },
    {
      id: 'notify',
      type: 'notify',
      label: '提醒评分人',
      config: {
        recipients: cel`scorers`,
        title: '考评单 {{ record.review_no }} 将于 {{ record.score_due }} 截止评分',
        message: '你还有未评的评分项。截止后未评的项按默认分处理并标记「未评」，请在考评单上点「提交评分」。',
        severity: 'warning',
        sourceObject: 'srm_performance_review',
        sourceId: cel`record.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_pending', type: 'default' },
    { id: 'e2', source: 'load_pending', target: 'reset', type: 'default' },
    { id: 'e3', source: 'reset', target: 'collect', type: 'default' },
    { id: 'e4', source: 'collect', target: 'has_scorers', type: 'default' },
    { id: 'e_notify', source: 'has_scorers', target: 'notify', type: 'conditional', condition: c('scorers.size() > 0'), label: '有' },
    { id: 'e_none', source: 'has_scorers', target: 'end', type: 'conditional', condition: c('scorers.size() == 0'), label: '没有' },
    { id: 'e5', source: 'notify', target: 'end', type: 'default' },
  ],
};
