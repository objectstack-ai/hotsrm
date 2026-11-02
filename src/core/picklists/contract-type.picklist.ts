import { definePicklist } from '@objectstack/spec/data';

// 合同类型：合同的 contract_type 用；扩展包按需追加（02 §1、§4.4）。
export const ContractTypePicklist = definePicklist({
  name: 'srm_contract_type',
  label: '合同类型',
  options: [
    { label: '框架协议', value: 'framework' },
    { label: '价格协议', value: 'price_agreement' },
    { label: '采购合同', value: 'purchase' },
    { label: '质量协议', value: 'quality_agreement' },
    { label: '廉洁协议', value: 'integrity' },
    { label: '保密协议', value: 'nda' },
  ],
});
