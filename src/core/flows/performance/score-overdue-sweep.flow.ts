import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { MISSING_SCORE } from './params.js';

// 评分截止（03 §10 第 3 步，FR-703）：人工评分中、已过评分截止日的考评单，未评的评分项取参数 perf_missing_score
// （params.ts 的 MISSING_SCORE，示例 60 分）并标记「未评」，考评单转审定中（srm_performance_publish 汇总分级）。
// 追赶式（03 §2.3 R2）：处理所有已过截止日还在人工评分的考评单，处理后离开人工评分，重复运行不重复处理；
// 漏跑一天，下一次补上。单张失败只跳过该张。
const c = (source: string) => ({ dialect: 'cel' as const, source });

export const ScoreOverdueSweepFlow: Automation.Flow = {
  name: 'srm_score_overdue_sweep',
  label: '绩效评分截止扫描',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每日 04:00', config: { schedule: '0 4 * * *' } },
    {
      id: 'load_due',
      type: 'get_record',
      label: '读取已过截止日的考评单',
      config: {
        objectName: 'srm_performance_review',
        filter: { status: 'scoring', score_due: { $lt: cel`isoDate(today())` } },
        fields: ['id'],
        limit: 20000,
        outputVariable: 'due',
      },
    },
    {
      id: 'each_review',
      type: 'loop',
      label: '逐张考评单',
      config: {
        collection: cel`due`,
        iteratorVariable: 'review',
        body: {
          nodes: [
            {
              id: 'guard_review',
              type: 'try_catch',
              label: '单张考评单',
              config: {
                try: {
                  nodes: [
                    {
                      id: 'default_missing',
                      type: 'update_record',
                      label: '未评项取默认分',
                      config: {
                        objectName: 'srm_performance_score',
                        filter: { review: cel`review.id`, scored: false },
                        fields: { score: c(`${MISSING_SCORE}.0`), scored: true, defaulted: true },
                        multi: true,
                      },
                    },
                    {
                      id: 'to_reviewing',
                      type: 'update_record',
                      label: '转审定中',
                      config: { objectName: 'srm_performance_review', filter: { id: cel`review.id` }, fields: { status: 'reviewing' } },
                    },
                  ],
                  edges: [{ id: 'e_review', source: 'default_missing', target: 'to_reviewing', type: 'default' }],
                },
                catch: { nodes: [{ id: 'skip_error', type: 'assignment', label: '跳过该考评单' }] },
              },
            },
          ],
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_due', type: 'default' },
    { id: 'e2', source: 'load_due', target: 'each_review', type: 'default' },
    { id: 'e3', source: 'each_review', target: 'end', type: 'default' },
  ],
};
