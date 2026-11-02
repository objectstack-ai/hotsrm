import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 作废考评单（02 §5.7）：人工评分中的考评单由采购总监写明理由后作废，例如供应商本期实际没有供货。作废的考评单仍占着
// supplier + period，同期要重新考评时由系统管理员删除后补跑生成。审定中的考评单先由采购总监退回重评再作废。
// 以系统身份运行，进门检查在 flow 里做。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const director = `current_user != null && 'srm_procurement_director' in current_user.positions`;
const scoring = `review != null && review.status == 'scoring'`;

export const PerformanceVoidFlow: Automation.Flow = {
  name: 'srm_performance_void',
  label: '作废考评单',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '考评单已作废',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取考评单',
      config: { objectName: 'srm_performance_review', filter: { id: cel`recordId` }, outputVariable: 'review' },
    },
    { id: 'gate', type: 'decision', label: '可以作废？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是采购总监',
      config: { outcome: 'refused', message: '考评单由采购总监作废' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不在人工评分',
      config: { outcome: 'refused', message: '只有人工评分中的考评单可以作废；审定中的先退回重评' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认作废',
      config: {
        title: '作废考评单：{{ review.review_no }}',
        description: '作废后这张考评单不再评分和发布；同期要重新考评时，请系统管理员删除后补跑生成。',
        fields: [{ name: 'reason_text', label: '作废理由', type: 'textarea', required: true }],
      },
    },
    {
      id: 'void',
      type: 'update_record',
      label: '置为已作废',
      config: { objectName: 'srm_performance_review', filter: { id: cel`review.id` }, fields: { status: 'void', void_reason: cel`reason_text` } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${director})`), label: '不是采购总监' },
    { id: 'e3', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${director} && !(${scoring})`), label: '不在人工评分' },
    { id: 'e4', source: 'gate', target: 'confirm', type: 'conditional', condition: c(`${director} && ${scoring}`), label: '可以' },
    { id: 'e5', source: 'confirm', target: 'void', type: 'default' },
    { id: 'e6', source: 'void', target: 'end', type: 'default' },
  ],
};
