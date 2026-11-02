import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { APPEAL_DAYS } from './params.js';

// 绩效申诉（03 §10 第 7 步，FR-706）：已发布的考评单在发布后 perf_appeal_days（params.ts 的 APPEAL_DAYS，示例 7 天）内
// 可以申诉一次，写申诉理由 → 申诉中，通知采购总监处理（srm_appeal_resolve）。v0.6 门户上线前供应商的申诉由采购员、
// 采购主管或品类经理代录，代录人记在考评单上；门户上线后供应商门户管理员经同一个 flow 提交。
// 以系统身份运行，因为考评单对所有人只读；进门检查在 flow 里做（同 srm_disposition_submit，objectstack#25481）。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const allowed =
  `current_user != null && ('srm_buyer' in current_user.positions || 'srm_buyer_lead' in current_user.positions`
  + ` || 'srm_category_manager' in current_user.positions)`;
const published = `review != null && review.status == 'published'`;
const once = `!(has(review.appeal_date) && review.appeal_date != null)`;
const inWindow = `has(review.published_date) && review.published_date != null && isoDate(today()) <= isoDate(addDays(date(review.published_date), ${APPEAL_DAYS}))`;

export const AppealSubmitFlow: Automation.Flow = {
  name: 'srm_appeal_submit',
  label: '绩效申诉',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '申诉已登记，等待采购总监处理',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取考评单',
      config: { objectName: 'srm_performance_review', filter: { id: cel`recordId` }, outputVariable: 'review' },
    },
    { id: 'gate', type: 'decision', label: '可以申诉？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '没有代录权限',
      config: { outcome: 'refused', message: '供应商的绩效申诉由采购员、采购主管或品类经理代录' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是已发布',
      config: { outcome: 'refused', message: '只有已发布的考评单可以申诉' },
    },
    {
      id: 'refuse_once',
      type: 'end',
      label: '已申诉过',
      config: { outcome: 'refused', message: '每张考评单只能申诉一次，这张已经申诉过' },
    },
    {
      id: 'refuse_window',
      type: 'end',
      label: '超过申诉期限',
      config: { outcome: 'refused', message: `已超过申诉期限：考评结果发布后 ${APPEAL_DAYS} 日内可以申诉` },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '登记申诉',
      config: {
        title: '绩效申诉：{{ review.review_no }}',
        description: '期间 {{ review.period }}，总分 {{ review.total_score }}。每张考评单只能申诉一次，提交后由采购总监处理。',
        fields: [{ name: 'appeal_text', label: '申诉理由', type: 'textarea', required: true }],
      },
    },
    {
      id: 'appeal',
      type: 'update_record',
      label: '置为申诉中',
      config: {
        objectName: 'srm_performance_review',
        filter: { id: cel`review.id` },
        fields: {
          status: 'appealed',
          appeal_reason: cel`appeal_text`,
          appeal_date: cel`isoDate(today())`,
          appeal_recorded_by: cel`current_user.id`,
        },
      },
    },
    {
      id: 'load_directors',
      type: 'get_record',
      label: '读取采购总监',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_procurement_director' }, limit: 50, outputVariable: 'directors' },
    },
    {
      id: 'notify',
      type: 'notify',
      label: '通知采购总监',
      config: {
        recipients: [cel`directors.map(p, p.user_id)`],
        title: '考评单 {{ review.review_no }} 有申诉待处理',
        message: '供应商对期间 {{ review.period }} 的考评结果提出申诉，理由见考评单。请在考评单上点「处理申诉」。',
        severity: 'warning',
        sourceObject: 'srm_performance_review',
        sourceId: cel`review.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${allowed})`), label: '没有权限' },
    { id: 'e3', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${allowed} && !(${published})`), label: '不是已发布' },
    { id: 'e4', source: 'gate', target: 'refuse_once', type: 'conditional', condition: c(`${allowed} && ${published} && !(${once})`), label: '已申诉过' },
    {
      id: 'e5',
      source: 'gate',
      target: 'refuse_window',
      type: 'conditional',
      condition: c(`${allowed} && ${published} && ${once} && !(${inWindow})`),
      label: '超过期限',
    },
    { id: 'e6', source: 'gate', target: 'confirm', type: 'conditional', condition: c(`${allowed} && ${published} && ${once} && ${inWindow}`), label: '可以' },
    { id: 'e7', source: 'confirm', target: 'appeal', type: 'default' },
    { id: 'e8', source: 'appeal', target: 'load_directors', type: 'default' },
    { id: 'e9', source: 'load_directors', target: 'notify', type: 'default' },
    { id: 'e10', source: 'notify', target: 'end', type: 'default' },
  ],
};
