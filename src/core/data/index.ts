import { defineSeed } from '@objectstack/spec/data';
import { Category } from '../objects/category.object.js';
import { Plant } from '../objects/plant.object.js';
import { Supplier } from '../objects/supplier.object.js';
import { Kpi } from '../objects/kpi.object.js';

// 演示数据。全部是标明「示例」的虚构值，不对应任何真实企业（AGENTS.md 红线 5）。
// 已合格的演示供应商按「存量导入、已复核」建档：新建即合格只允许存量导入（02 §5.1）。
// 用 ignore 只补缺不覆盖：每次启动都会重放种子，upsert 会把用户改过的记录（如准入后的供应商状态）改回初值。

const categories = defineSeed(Category, {
  mode: 'ignore',
  externalId: 'code',
  records: [
    { code: 'ELEC', name: '电子元器件', material_class: 'class_a', risk_class: 'high', is_direct: true, mandatory_cert_types: ['business_license', 'iso9001'] },
    { code: 'PACK', name: '包装材料', material_class: 'class_c', risk_class: 'low', is_direct: true, mandatory_cert_types: ['business_license'] },
    { code: 'MRO', name: '工业品与备件', material_class: 'class_b', risk_class: 'medium', is_direct: false, mandatory_cert_types: ['business_license'] },
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

// 示例绩效指标库（02 §4.7，QP-01 附录 D）：权重取 params/core.yaml 的 perf_kpi_weights（示例值，客户改参数时同步这里），
// 启用指标的权重合计 100%。自动指标口径见 05 §4.1；订单响应及时率要 ERP 订单确认数据，集成前不启用，启用时由采购总监调整其余权重
const kpis = defineSeed(Kpi, {
  mode: 'ignore',
  externalId: 'code',
  records: [
    { code: 'LOT_PASS', name: '批次合格率', dimension: 'quality', method: 'auto', auto_metric: 'lot_pass_rate', weight: 0.2, full_score_value: 99, zero_score_value: 89, scoring_rule: '示例：检验合格批次 ÷ 已检验批次（让步接收计为不合格）；≥ 99% 得满分，每低 1% 扣 10 分' },
    { code: 'PPM', name: '来料不良 PPM', dimension: 'quality', method: 'auto', auto_metric: 'ppm', weight: 0.1, full_score_value: 100, zero_score_value: 5000, scoring_rule: '示例：不良数 ÷ 实收数 × 1,000,000；≤ 100 得满分，≥ 5000 得 0 分，之间按比例' },
    { code: 'OTD', name: '交付准时率', dimension: 'delivery', method: 'auto', auto_metric: 'otd_rate', weight: 0.15, full_score_value: 98, zero_score_value: 78, scoring_rule: '示例：准时交付行 ÷ 交付行（无承诺交期时按需求日期）；≥ 98% 得满分，每低 1% 扣 5 分' },
    { code: 'PLAN_FULFIL', name: '计划完成率', dimension: 'delivery', method: 'manual', weight: 0.1, scoring_rule: '示例：采购员按实际供货量 ÷ 月度计划量评分，100% 得满分' },
    { code: 'ACK_ON_TIME', name: '订单响应及时率', dimension: 'delivery', method: 'auto', auto_metric: 'ack_on_time_rate', weight: 0.1, active: false, full_score_value: 95, zero_score_value: 75, scoring_rule: '示例：下发后 24 小时内确认的订单 ÷ 下发订单；ERP 集成后启用' },
    { code: 'PRICE', name: '价格竞争力', dimension: 'cost', method: 'manual', weight: 0.2, scoring_rule: '示例：品类经理对比市场参考价或同类供应商价格评分' },
    { code: 'SERVICE', name: '响应与配合', dimension: 'service', method: 'manual', weight: 0.1, scoring_rule: '示例：问题处理、资料提交、对账配合的及时性，由采购员评分' },
    { code: 'SAFETY_ENV', name: '安全环保合规', dimension: 'hse', method: 'manual', weight: 0.15, scoring_rule: '示例：送货与现场作业安全、环保合规，按发生的事件扣分，由 SQE 评分' },
  ],
});

export const SrmSeedData = [categories, plants, suppliers, kpis];
