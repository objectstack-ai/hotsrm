import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 质量协议 / 廉洁协议标志（02 §4.1，03 §6 第 4 步）：这两类合同进入或离开「生效」时，重算供应商的
// quality_agreement_signed / integrity_agreement_signed——这家供应商还有生效中的同类协议就为 true，否则为 false。
// 所以协议到期或终止、又没有续上的，标志会回到 false。
const flag = (type: string, field: string): Automation.FlowNode[] => [
  {
    id: `find_${type}`,
    type: 'get_record',
    label: '找一份生效中的同类协议',
    config: {
      objectName: 'srm_contract',
      filter: { supplier: cel`record.supplier`, contract_type: type, status: 'active' },
      outputVariable: 'activeAgreement',
    },
  },
  { id: `check_${type}`, type: 'decision', label: '还有生效中的协议？' },
  {
    id: `set_${type}`,
    type: 'update_record',
    label: '标志置为 true',
    config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { [field]: true } },
  },
  {
    id: `clear_${type}`,
    type: 'update_record',
    label: '标志置为 false',
    config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { [field]: false } },
  },
];

const branch = (type: string): Automation.FlowEdge[] => [
  { id: `e_${type}`, source: 'by_type', target: `find_${type}`, type: 'conditional', condition: { dialect: 'cel', source: `record.contract_type == '${type}'` } },
  { id: `e_${type}_check`, source: `find_${type}`, target: `check_${type}`, type: 'default' },
  { id: `e_${type}_set`, source: `check_${type}`, target: `set_${type}`, type: 'conditional', condition: P`activeAgreement != null`, label: '有' },
  { id: `e_${type}_clear`, source: `check_${type}`, target: `clear_${type}`, type: 'conditional', condition: P`activeAgreement == null`, label: '没有' },
  { id: `e_${type}_set_end`, source: `set_${type}`, target: 'end', type: 'default' },
  { id: `e_${type}_clear_end`, source: `clear_${type}`, target: 'end', type: 'default' },
];

export const ContractAgreementRecalcFlow: Automation.Flow = {
  name: 'srm_contract_agreement_recalc',
  label: '协议标志重算',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '协议进入或离开生效',
      config: {
        objectName: 'srm_contract',
        triggerType: 'record-after-update',
        condition: P`(record.contract_type == 'quality_agreement' || record.contract_type == 'integrity')
          && has(previous.status) && record.status != previous.status
          && (record.status == 'active' || previous.status == 'active')`,
      },
    },
    { id: 'by_type', type: 'decision', label: '协议类型' },
    ...flag('quality_agreement', 'quality_agreement_signed'),
    ...flag('integrity', 'integrity_agreement_signed'),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e_start', source: 'start', target: 'by_type', type: 'default' },
    ...branch('quality_agreement'),
    ...branch('integrity'),
  ],
};
