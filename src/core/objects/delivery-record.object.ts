import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 交付记录（02 §4.6，03 §8）：ERP 收货与检验结果的月度副本，只为算绩效和开整改单，不改库存、不对账（ADR-0008）。
// 每月用平台导入按 ERP 收货单号 + 订单号 + 行号幂等写入；没有质量系统的客户由质检员逐条录入。
// 一条订单行可以分几次到货，每次到货一条记录，所以匹配键里有收货单号（02 §4.6）。
// 指标口径（05 §4.1）要的值在写入时由引擎按表达式算好存下（on_time、period、received_quantity_mn），
// 导入、手工录入和以后的 ERP upsert 走同一条写入路径，结果一致；表格里带了这些列也会被重算覆盖。
const has = (k: string) => `(has(record.${k}) && record.${k} != null)`;
const num = (k: string) => `(${has(k)} ? double(record.${k}) : 0.0)`;
const cel = (source: string) => ({ dialect: 'cel' as const, source });
const nonconforming = P`record.inspection_result == 'fail' || record.inspection_result == 'concession'`;

export const DeliveryRecord = ObjectSchema.create({
  name: 'srm_delivery_record',
  label: '交付记录',
  pluralLabel: '交付记录',
  icon: 'truck',
  // 内部只读，录入经 srm_quality / srm_iqc，删除只给 srm_admin；portal_position 与门户 RLS 在 v0.6 加（ADR-0003）
  sharingModel: 'public_read',
  nameField: 'erp_order_no',

  fieldGroups: [
    { key: 'order', label: '订单与收货', icon: 'truck' },
    { key: 'inspection', label: '检验', icon: 'microscope' },
    { key: 'metrics', label: '指标', icon: 'chart-column' },
  ],

  fields: {
    erp_receipt_no: Field.text({ label: 'ERP 收货单号', group: 'order', required: true, searchable: true, maxLength: 40 }),
    erp_order_no: Field.text({ label: 'ERP 订单号', group: 'order', required: true, searchable: true, maxLength: 40 }),
    erp_line_no: Field.text({ label: 'ERP 订单行号', group: 'order', required: true, maxLength: 20 }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'order',
      required: true,
      relatedListColumns: ['erp_order_no', 'erp_line_no', 'material', 'receipt_date', 'received_quantity', 'on_time', 'inspection_result', 'defect_quantity', 'period'],
    }),
    // 导入时按 ERP 物料号找物料（找不到再按物料名称）
    material: Field.lookup('srm_material', { label: '物料', group: 'order', required: true, displayField: 'erp_material_no' }),
    // 导入时按工厂编码找工厂（找不到再按工厂名称）
    plant: Field.lookup('srm_plant', { label: '工厂', group: 'order', displayField: 'code' }),
    required_date: Field.date({ label: '需求日期', group: 'order', required: true }),
    promised_date: Field.date({ label: '承诺日期', group: 'order' }),
    receipt_date: Field.date({ label: '实到日期', group: 'order', required: true }),
    ordered_quantity: Field.number({ label: '订单数量', group: 'order', min: 0 }),
    received_quantity: Field.number({ label: '实收数量', group: 'order', required: true, min: 0 }),
    accepted_quantity: Field.number({ label: '合格数量', group: 'inspection', min: 0 }),
    uom: Field.text({ label: '单位', group: 'order', maxLength: 20 }),
    amount: Field.currency({ label: '金额', group: 'order', min: 0 }),
    inspection_result: Field.select({
      label: '检验结论',
      group: 'inspection',
      required: true,
      defaultValue: 'not_inspected',
      options: [
        { label: '合格', value: 'pass' },
        { label: '不合格', value: 'fail' },
        { label: '让步接收', value: 'concession' },
        { label: '未检', value: 'not_inspected' },
      ],
    }),
    severity: Field.select({
      label: '严重度',
      group: 'inspection',
      requiredWhen: P`record.inspection_result == 'fail'`,
      options: [
        { label: '严重', value: 'critical' },
        { label: '主要', value: 'major' },
        { label: '次要', value: 'minor' },
      ],
    }),
    defect_quantity: Field.number({ label: '不良数', group: 'inspection', min: 0, requiredWhen: nonconforming }),
    defect_description: Field.textarea({ label: '不良描述', group: 'inspection', maxLength: 2000 }),

    // 准时：实到日不晚于承诺日期；没有承诺日期按需求日期（05 §4.1 OTD）
    on_time: Field.boolean({
      label: '准时',
      group: 'metrics',
      defaultValue: false,
      readonly: true,
      expression: cel(`${has('promised_date')} ? record.receipt_date <= record.promised_date : record.receipt_date <= record.required_date`),
    }),
    // 所属期间取实到日期的年月（YYYY-MM），考评按它汇总
    period: Field.text({
      label: '期间',
      group: 'metrics',
      readonly: true,
      maxLength: 7,
      expression: cel('string(record.receipt_date).substring(0, 7)'),
    }),
    // PPM = Σ不良数 ÷ Σ实收数 × 1,000,000。仪表盘只能对存储的数值字段求和、再取两个合计的比值，
    // 所以存一份「实收数量（百万）」，PPM 就是 Σdefect_quantity ÷ Σreceived_quantity_mn（05 §4.1）
    received_quantity_mn: Field.number({
      label: '实收数量（百万）',
      group: 'metrics',
      readonly: true,
      scale: 9,
      expression: cel(`${num('received_quantity')} / 1000000.0`),
    }),
  },

  indexes: [{ name: 'srm_delivery_record_erp_receipt', fields: ['erp_receipt_no', 'erp_order_no', 'erp_line_no'], unique: 'organization' }],

  validations: [
    {
      name: 'defect_not_above_received',
      type: 'script',
      severity: 'error',
      message: '不良数不能大于实收数量',
      condition: cel(`${has('defect_quantity')} && ${has('received_quantity')} && record.defect_quantity > record.received_quantity`),
    },
    {
      name: 'accepted_not_above_received',
      type: 'script',
      severity: 'error',
      message: '合格数量不能大于实收数量',
      condition: cel(`${has('accepted_quantity')} && ${has('received_quantity')} && record.accepted_quantity > record.received_quantity`),
    },
  ],
});
