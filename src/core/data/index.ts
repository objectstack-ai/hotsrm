import { defineSeed } from '@objectstack/spec/data';
import { Category } from '../objects/category.object.js';
import { Plant } from '../objects/plant.object.js';
import { Supplier } from '../objects/supplier.object.js';

// 演示数据。全部是标明「示例」的虚构值，不对应任何真实企业（AGENTS.md 红线 5）。
// 已合格的演示供应商按「存量导入、已复核」建档：新建即合格只允许存量导入（02 §5.1）。
// 用 ignore 只补缺不覆盖：每次启动都会重放种子，upsert 会把用户改过的记录（如准入后的供应商状态）改回初值。

const categories = defineSeed(Category, {
  mode: 'ignore',
  externalId: 'code',
  records: [
    { code: 'ELEC', name: '电子元器件', risk_class: 'high', is_direct: true, mandatory_cert_types: ['business_license', 'iso9001'] },
    { code: 'PACK', name: '包装材料', risk_class: 'low', is_direct: true, mandatory_cert_types: ['business_license'] },
    { code: 'MRO', name: '工业品与备件', risk_class: 'medium', is_direct: false, mandatory_cert_types: ['business_license'] },
  ],
});

const plants = defineSeed(Plant, {
  mode: 'ignore',
  externalId: 'code',
  records: [
    { code: 'P100', name: '示例一厂', legal_entity: '示例制造有限公司' },
    { code: 'P200', name: '示例二厂', legal_entity: '示例制造有限公司' },
  ],
});

const suppliers = defineSeed(Supplier, {
  mode: 'ignore',
  externalId: 'name',
  records: [
    { name: '示例电子科技有限公司', short_name: '示例电子', country: 'cn', credit_code: '91000000MA0EXAMP01', supplier_type: 'manufacturer', status: 'qualified', risk_level: 'low', legacy_imported: true, legacy_reviewed: true },
    { name: '示例包装制品有限公司', short_name: '示例包装', country: 'cn', credit_code: '91000000MA0EXAMP02', supplier_type: 'manufacturer', status: 'potential' },
    { name: 'Example Components GmbH', short_name: 'Example Components', country: 'de', registration_no: 'DE000000000', supplier_type: 'distributor', status: 'potential' },
  ],
});

export const SrmSeedData = [categories, plants, suppliers];
