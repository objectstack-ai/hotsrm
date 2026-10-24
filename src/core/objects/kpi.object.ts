import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 绩效指标库（02 §4.7，FR-701）：考评生成时按启用的指标为每张考评单建评分明细（03 §10，v0.5 P2）。
// 一套全局方案：启用指标的权重合计应为 100%，由视图「启用指标」的权重合计检查（跨记录合计写不成单条校验规则，
// 工程规范 §1「跨记录规则不写校验规则」）；考评生成 flow 再守一次。采购总监经 srm_performance 维护，删除只给 srm_admin，
// 停用代替删除。自动指标的口径见 05 §4.1，auto_metric 指向考评单上对应的比率字段。
const cel = (source: string) => ({ dialect: 'cel' as const, source });
const has = (k: string) => `(has(record.${k}) && record.${k} != null)`;
const filled = (k: string) => `(${has(k)} && !isBlank(record.${k}))`;
const auto = P`record.method == 'auto'`;
// 表单帮助文字。临时：i18n 检查不把源语言的 inlineHelpText 算作 zh-CN 词条，英文给了 help 后要 zh-CN 也有一份
// （objectstack#25683），所以 zh-CN 翻译包引用这里的同一份文字（translations/index.ts），平台修复后删掉 zh-CN 包
export const KpiHelp = {
  full_score_value: '原始值达到此值得 100 分；比率按百分点填（98 即 98%），PPM 按 PPM 填',
  zero_score_value: '原始值达到此值得 0 分，与满分值之间按比例计分',
};

export const Kpi = ObjectSchema.create({
  name: 'srm_kpi',
  label: '绩效指标',
  pluralLabel: '绩效指标',
  icon: 'gauge',
  // 内部只读；采购总监改别人建的指标（含示例种子）靠共享规则 srm_kpi_director_edit 授予编辑，不用 modifyAllRecords
  // （它会连删除一起放开，objectstack#25470 裁定「可改不可删」用共享规则表达）；删除只给 srm_admin
  sharingModel: 'public_read',
  enable: { trackHistory: true },

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'gauge' },
    { key: 'scoring', label: '评分规则', icon: 'calculator' },
  ],

  fields: {
    code: Field.text({ label: '指标编码', group: 'basic', required: true, unique: true, maxLength: 40 }),
    name: Field.text({ label: '指标名称', group: 'basic', required: true, searchable: true, maxLength: 100 }),
    dimension: Field.select({ label: '维度', group: 'basic', required: true, picklist: 'srm_kpi_dimension' }),
    method: Field.select({
      label: '评分方式',
      group: 'basic',
      required: true,
      defaultValue: 'manual',
      options: [
        { label: '自动', value: 'auto' },
        { label: '人工', value: 'manual' },
      ],
    }),
    // 考评单上的比率字段名（02 §4.7）：算分 flow 按它取本期汇总的原始值
    auto_metric: Field.select({
      label: '自动指标口径',
      group: 'basic',
      requiredWhen: auto,
      visibleWhen: auto,
      options: [
        { label: '交付准时率 OTD', value: 'otd_rate' },
        { label: '批次合格率', value: 'lot_pass_rate' },
        { label: 'PPM', value: 'ppm' },
        { label: '订单响应及时率', value: 'ack_on_time_rate' },
      ],
    }),
    weight: Field.percent({ label: '权重', group: 'basic', required: true, min: 0, max: 1 }),
    // 人工指标和没有数据的自动指标由谁评分（03 §10 第 3 步）：考评生成时按它从供应商的品类上取评分人
    scorer_type: Field.select({
      label: '评分人',
      group: 'basic',
      defaultValue: 'category_manager',
      options: [
        { label: '品类经理', value: 'category_manager' },
        { label: '采购员', value: 'buyer' },
        { label: 'SQE', value: 'sqe' },
        { label: '需求部门评分人', value: 'evaluator' },
      ],
    }),
    active: Field.boolean({ label: '启用', group: 'basic', defaultValue: true }),
    scoring_rule: Field.textarea({ label: '评分规则说明', group: 'scoring', maxLength: 2000 }),
    // 自动指标线性算分：原始值达到满分值得 100 分，达到零分值得 0 分，之间按比例，越界取 0 或 100。
    // 满分值大于零分值时越高越好（OTD、批次合格率），小于时越低越好（PPM）；比率按百分点填，PPM 按 PPM 填
    full_score_value: Field.number({
      label: '满分值',
      group: 'scoring',
      scale: 2,
      requiredWhen: auto,
      visibleWhen: auto,
      inlineHelpText: KpiHelp.full_score_value,
    }),
    zero_score_value: Field.number({
      label: '零分值',
      group: 'scoring',
      scale: 2,
      requiredWhen: auto,
      visibleWhen: auto,
      inlineHelpText: KpiHelp.zero_score_value,
    }),
  },

  validations: [
    {
      name: 'manual_without_auto_metric',
      type: 'script',
      severity: 'error',
      message: '人工指标不填自动指标口径',
      condition: cel(`record.method == 'manual' && ${filled('auto_metric')}`),
    },
    {
      name: 'score_values_differ',
      type: 'script',
      severity: 'error',
      message: '满分值与零分值不能相同',
      condition: cel(`record.method == 'auto' && ${has('full_score_value')} && ${has('zero_score_value')} && record.full_score_value == record.zero_score_value`),
    },
    {
      name: 'active_weight_positive',
      type: 'script',
      severity: 'error',
      message: '启用的指标权重必须大于 0',
      condition: cel(`record.active == true && (!${has('weight')} || record.weight <= 0)`),
    },
  ],
});
