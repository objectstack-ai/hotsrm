import { defineSeed } from '@objectstack/spec/data';
import { Category } from '../objects/category.object.js';
import { Plant } from '../objects/plant.object.js';
import { Supplier } from '../objects/supplier.object.js';

// 演示数据。全部是标明「示例」的虚构值，不对应任何真实企业（AGENTS.md 红线 5）。

const categories = defineSeed(Category, {
  mode: 'upsert',
  externalId: 'code',
  records: [
    { code: 'ELEC', name: '电子元器件', risk_class: 'high', is_direct: true, mandatory_cert_types: ['business_license', 'iso9001'] },
    { code: 'PACK', name: '包装材料', risk_class: 'low', is_direct: true, mandatory_cert_types: ['business_license'] },
    { code: 'MRO', name: '工业品与备件', risk_class: 'medium', is_direct: false, mandatory_cert_types: ['business_license'] },
  ],
});

const plants = defineSeed(Plant, {
  mode: 'upsert',
  externalId: 'code',
  records: [
    { code: 'P100', name: '示例一厂', legal_entity: '示例制造有限公司' },
    { code: 'P200', name: '示例二厂', legal_entity: '示例制造有限公司' },
  ],
});

const suppliers = defineSeed(Supplier, {
  mode: 'upsert',
  externalId: 'name',
  records: [
    { name: '示例电子科技有限公司', short_name: '示例电子', country: 'cn', credit_code: '91000000MA0EXAMP01', supplier_type: 'manufacturer', status: 'qualified', risk_level: 'low' },
    { name: '示例包装制品有限公司', short_name: '示例包装', country: 'cn', credit_code: '91000000MA0EXAMP02', supplier_type: 'manufacturer', status: 'potential' },
    { name: 'Example Components GmbH', short_name: 'Example Components', country: 'de', registration_no: 'DE000000000', supplier_type: 'distributor', status: 'potential' },
  ],
});

export const SrmSeedData = [categories, plants, suppliers];
