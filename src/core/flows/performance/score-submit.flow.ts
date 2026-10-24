import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 提交评分（03 §10 第 3 步，FR-703）：评分人在人工评分中的考评单上点「提交评分」，flow 只列出指派给本人的评分项，
// 逐项显示指标、评分规则、原始值和权重，填 0–100 分与说明；已评的项会带出原来的分数，截止前可以改。
// 填完最后一项后，考评单上全部评分项都已评分时转审定中（srm_performance_publish 汇总分级并交采购总监审定）。
// 以系统身份运行：考评单与评分明细对所有内部岗位只读，评分只经这里写入，所以绕过界面也改不了别人的评分项。
// 逐项循环用顶层的回边（screen 不能放在 loop 节点里暂停）。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;
const open = `current_user != null && review != null && review.status == 'scoring'`;

export const ScoreSubmitFlow: Automation.Flow = {
  name: 'srm_score_submit',
  label: '提交评分',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '评分已提交',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取考评单',
      config: { objectName: 'srm_performance_review', filter: { id: cel`recordId` }, outputVariable: 'review' },
    },
    { id: 'gate', type: 'decision', label: '人工评分中？' },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不在人工评分',
      config: { outcome: 'refused', message: '只有人工评分中的考评单可以提交评分' },
    },
    {
      id: 'load_mine',
      type: 'get_record',
      label: '读取指派给本人的评分项',
      config: {
        objectName: 'srm_performance_score',
        filter: { review: cel`review.id`, scorer: cel`current_user.id` },
        limit: 200,
        outputVariable: 'mine',
      },
    },
    { id: 'has_mine', type: 'decision', label: '有指派给本人的评分项？' },
    {
      id: 'refuse_none',
      type: 'end',
      label: '没有指派给本人的评分项',
      config: { outcome: 'refused', message: '这张考评单没有指派给你的评分项' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`review.supplier` }, fields: ['name'], outputVariable: 'vendor' },
    },
    {
      id: 'load_kpis',
      type: 'get_record',
      label: '读取指标',
      config: {
        objectName: 'srm_kpi',
        filter: { id: { $in: cel`mine.map(l, l.kpi)` } },
        fields: ['id', 'name', 'scoring_rule'],
        limit: 200,
        outputVariable: 'kpis',
      },
    },
    { id: 'init', type: 'assignment', label: '从第一项开始', config: { assignments: { i: cel`0`, count: cel`mine.size()` } } },
    {
      id: 'pick',
      type: 'assignment',
      label: '取下一项',
      config: {
        assignments: {
          line: cel`mine[i]`,
          n: cel`i + 1`,
          kpiName: cel$(`kpis.exists(k, k.id == line.kpi) ? kpis.filter(k, k.id == line.kpi)[0].name : ''`),
          ruleText: cel$(
            `kpis.exists(k, k.id == line.kpi && ${val('k.scoring_rule')}) ? kpis.filter(k, k.id == line.kpi)[0].scoring_rule : '—'`,
          ),
          rawText: cel$(`${val('line.raw_value')} ? string(line.raw_value) : '—'`),
          weightText: cel$(`${val('line.weight')} ? string(double(round(double(line.weight) * 10000.0)) / 100.0) : '—'`),
          noteText: cel$(`${val('line.comment')} ? line.comment : ''`),
        },
      },
    },
    {
      id: 'score_line',
      type: 'screen',
      label: '评分',
      config: {
        title: '评分：{{ kpiName }}（{{ n }} / {{ count }}）',
        description:
          '考评单：{{ review.review_no }}　供应商：{{ vendor.name }}　期间：{{ review.period }}\n'
          + '评分规则：{{ ruleText }}\n原始值：{{ rawText }}　权重：{{ weightText }}%\n{{ noteText }}',
        fields: [
          {
            name: 'score',
            label: '得分（0–100）',
            type: 'number',
            required: true,
            min: 0,
            max: 100,
            defaultValue: cel$(`${val('line.score')} ? line.score : null`),
          },
          { name: 'score_note', label: '评分说明', type: 'textarea', defaultValue: cel$(`${val('line.comment')} ? line.comment : ''`) },
        ],
      },
    },
    {
      id: 'save',
      type: 'update_record',
      label: '写入评分',
      config: {
        objectName: 'srm_performance_score',
        filter: { id: cel`line.id` },
        fields: {
          score: cel`double(round(double(score) * 100.0)) / 100.0`,
          comment: cel$(`${val('vars.score_note')} && vars.score_note != '' ? vars.score_note : null`),
          scored: true,
          defaulted: false,
        },
      },
    },
    { id: 'advance', type: 'assignment', label: '下一项', config: { assignments: { i: cel`i + 1` } } },
    { id: 'more', type: 'decision', label: '还有指派给本人的评分项？' },
    { id: 'next_line', type: 'assignment', label: '回到下一项' },
    {
      id: 'load_rest',
      type: 'get_record',
      label: '还有未评的评分项？',
      config: { objectName: 'srm_performance_score', filter: { review: cel`review.id`, scored: false }, fields: ['id'], outputVariable: 'rest' },
    },
    { id: 'all_scored', type: 'decision', label: '全部评分项都已评分？' },
    {
      id: 'to_reviewing',
      type: 'update_record',
      label: '转审定中',
      config: { objectName: 'srm_performance_review', filter: { id: cel`review.id` }, fields: { status: 'reviewing' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_status', type: 'conditional', condition: cel$(`!(${open})`), label: '不在人工评分' },
    { id: 'e3', source: 'gate', target: 'load_mine', type: 'conditional', condition: cel$(open), label: '人工评分中' },
    { id: 'e4', source: 'load_mine', target: 'has_mine', type: 'default' },
    { id: 'e5', source: 'has_mine', target: 'refuse_none', type: 'conditional', condition: cel$('mine.size() == 0'), label: '没有' },
    { id: 'e6', source: 'has_mine', target: 'load_supplier', type: 'conditional', condition: cel$('mine.size() > 0'), label: '有' },
    { id: 'e7', source: 'load_supplier', target: 'load_kpis', type: 'default' },
    { id: 'e8', source: 'load_kpis', target: 'init', type: 'default' },
    { id: 'e9', source: 'init', target: 'pick', type: 'default' },
    { id: 'e10', source: 'pick', target: 'score_line', type: 'default' },
    { id: 'e11', source: 'score_line', target: 'save', type: 'default' },
    { id: 'e12', source: 'save', target: 'advance', type: 'default' },
    { id: 'e13', source: 'advance', target: 'more', type: 'default' },
    { id: 'e_next', source: 'more', target: 'next_line', type: 'conditional', condition: cel$('i < count'), label: '还有' },
    { id: 'e_back', source: 'next_line', target: 'pick', type: 'back', label: '下一项' },
    { id: 'e_done', source: 'more', target: 'load_rest', type: 'conditional', condition: cel$('i >= count'), label: '本人的都评完了' },
    { id: 'e14', source: 'load_rest', target: 'all_scored', type: 'default' },
    { id: 'e_all', source: 'all_scored', target: 'to_reviewing', type: 'conditional', condition: cel$('rest == null'), label: '全部已评' },
    { id: 'e_partial', source: 'all_scored', target: 'end', type: 'conditional', condition: cel$('rest != null'), label: '还有别人的未评项' },
    { id: 'e15', source: 'to_reviewing', target: 'end', type: 'default' },
  ],
};
