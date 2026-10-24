import type * as Automation from '@objectstack/spec/automation';

// P9 步骤 1–2（03 §10，FR-702）：生成考评单并自动算分。
//
// 生成：活跃供应商（合格或冻结——冻结期间仍在交付在途订单，连续 D 级要能累计，03 §10 第 6 步）按所供品类中最高的
// 物资类别（srm_category.material_class，品类资格不论状态）取周期：参数 perf_cycle（示例 A 类每月、B 类每季、C 类每年），
// 客户改参数时同步 CYCLE。每期的第一个月为「到期」，生成上一期的考评单（calculating），按指标库中启用的指标各建一行评分
// 明细并快照权重。启用指标的权重合计不是 100% 时本次不生成，通知采购总监。没有品类资格的供应商不生成。
//
// 自动算分：按供应商与 period 汇总交付记录，口径同数据集 srm_delivery_metrics（05 §4.1）：OTD = 准时行 ÷ 交付行；
// 批次合格率 = 合格行 ÷ 已检行（让步接收计不合格）；PPM = Σ不良数 ÷ Σ实收数 × 1,000,000。写入考评单的比率字段，
// 再按每条自动指标的满分值、零分值线性算分（02 §4.7），得分规则全在指标库里，这里不写死数字。本期没有交付记录、
// 某项指标没有数据（如没有已检批次）时该项不给分、考评单标记「数据不全」（07 R7）。算完转人工评分（scoring）。
//
// 追赶式（03 §2.3 R2）：每月 1–7 日每天 03:00 运行，同一供应商同一期间已有考评单的跳过，1 日漏跑后几天补上，跑两遍不
// 重复建（考评单上 supplier + period 唯一索引兜底）。补跑更早的月份时传入运行日 asOf（如 2026-10-01）。
// 单家失败只跳过该家，不中断整次生成。
//
// 临时：CEL 没有对列表求和，flow 也没有汇总节点，Σ不良数、Σ实收数与权重合计只能逐行累加（07 §6.3 PF15，
// 数据点记在 objectstack#14500）；平台给出汇总能力后改掉。
export const CYCLE = { class_a: 'monthly', class_b: 'quarterly', class_c: 'yearly' } as const;

type Cel = { dialect: 'cel'; source: string };
const c = (source: string): Cel => ({ dialect: 'cel', source });
const val = (k: string) => `(has(${k}) && ${k} != null)`;
const round = (x: string, digits: number) => `(double(round((${x}) * ${10 ** digits}.0)) / ${10 ** digits}.0)`;

// 供应商的类别：A 优先于 B 优先于 C
const classOf = (['class_a', 'class_b', 'class_c'] as const).reduceRight(
  (rest, cls) => `cats.exists(x, ${val('x.material_class')} && x.material_class == '${cls}') ? '${cls}' : ${rest}`,
  `''`,
);
const cycleOf = (Object.entries(CYCLE) as Array<[string, string]>).reduceRight(
  (rest, [cls, cycle]) => `supplierClass == '${cls}' ? '${cycle}' : ${rest}`,
  `''`,
);
// 每期的第一个月到期（月份从 0 起）
const due = `(cycle == 'monthly' || (cycle == 'quarterly' && runMonth % 3 == 0) || (cycle == 'yearly' && runMonth == 0))`;
const isDue = `(cycle != '' && ${due})`;
const stale = `(existing != null && existing.status == 'calculating')`;
const span = (n: number) => `[${Array.from({ length: n }, (_, i) => i).join(', ')}]`;

// 某条指标在本期的原始值（与满分值、零分值同一单位）；人工指标与没有数据源的自动指标为 null
const rawOf = (k: string) =>
  `(${k}.method == 'auto' && ${val(`${k}.auto_metric`)} ? (`
  + `${k}.auto_metric == 'otd_rate' ? otdRaw : ${k}.auto_metric == 'lot_pass_rate' ? lotRaw : ${k}.auto_metric == 'ppm' ? ppmRaw : null) : null)`;
const scoreOf = (k: string, raw: string) =>
  `(${raw} == null ? null : ${round(
    `max(0.0, min(100.0, 100.0 * (${raw} - double(${k}.zero_score_value)) / (double(${k}.full_score_value) - double(${k}.zero_score_value))))`,
    2,
  )})`;

const supplierBody: Automation.FlowNode[] = [
  {
    id: 'find_grants',
    type: 'get_record',
    label: '读取品类资格',
    config: { objectName: 'srm_supplier_category', filter: { supplier: c('vendor.id') }, fields: ['category'], limit: 500, outputVariable: 'grants' },
  },
  { id: 'has_grants', type: 'decision', label: '有品类资格？' },
  {
    id: 'find_categories',
    type: 'get_record',
    label: '读取所供品类',
    config: {
      objectName: 'srm_category',
      filter: { id: { $in: c('grants.map(g, g.category)') } },
      fields: ['material_class'],
      limit: 500,
      outputVariable: 'cats',
    },
  },
  {
    id: 'classify',
    type: 'assignment',
    label: '定周期与期间',
    config: {
      assignments: {
        supplierClass: c(classOf),
        cycle: c(cycleOf),
        periodStart: c(`cycle == 'monthly' ? startMonthly : cycle == 'quarterly' ? startQuarterly : startYearly`),
        period: c(
          `cycle == 'monthly' ? isoDate(periodStart).substring(0, 7)`
          + ` : cycle == 'quarterly' ? string(periodStart.getFullYear()) + 'Q' + string(periodStart.getMonth() / 3 + 1)`
          + ` : string(periodStart.getFullYear())`,
        ),
        // 本期包含的月份，交付记录的 period 是实到日期的年月
        months: c(
          `(cycle == 'monthly' ? ${span(1)} : cycle == 'quarterly' ? ${span(3)} : ${span(12)}).map(i, isoDate(addMonths(periodStart, i)).substring(0, 7))`,
        ),
      },
    },
  },
  {
    id: 'find_existing',
    type: 'get_record',
    label: '本期已有考评单？',
    config: { objectName: 'srm_performance_review', filter: { supplier: c('vendor.id'), period: c('period') }, fields: ['id', 'status'], outputVariable: 'existing' },
  },
  { id: 'is_due', type: 'decision', label: '本期到期且未生成？' },
  // 上次运行中途失败留下的「自动算分」考评单（正常运行在同一次里转人工评分）：删掉（评分明细随之删除）后重建
  {
    id: 'delete_stale',
    type: 'delete_record',
    label: '删除未算完的考评单',
    config: { objectName: 'srm_performance_review', filter: { id: c('existing.id') } },
  },
  {
    id: 'create_review',
    type: 'create_record',
    label: '生成考评单',
    config: {
      objectName: 'srm_performance_review',
      fields: {
        supplier: c('vendor.id'),
        cycle: c('cycle'),
        period: c('period'),
        period_start: c('isoDate(periodStart)'),
        period_end: c('periodEnd'),
        status: 'calculating',
      },
      outputVariable: 'review',
    },
  },
  {
    id: 'find_deliveries',
    type: 'get_record',
    label: '读取本期交付记录',
    config: {
      objectName: 'srm_delivery_record',
      filter: { supplier: c('vendor.id'), period: { $in: c('months') } },
      fields: ['on_time', 'inspection_result', 'defect_quantity', 'received_quantity'],
      limit: 50000,
      outputVariable: 'deliveries',
    },
  },
  {
    id: 'reset_sums',
    type: 'assignment',
    label: '累计清零',
    config: { assignments: { defectSum: c('0.0'), receivedSum: c('0.0'), lineFailed: c('false') } },
  },
  {
    id: 'sum_deliveries',
    type: 'loop',
    label: '累计不良数与实收数',
    config: {
      collection: c('deliveries'),
      iteratorVariable: 'line',
      body: {
        nodes: [
          {
            id: 'add_line',
            type: 'assignment',
            label: '累加',
            config: {
              assignments: {
                defectSum: c(`defectSum + (${val('line.defect_quantity')} ? double(line.defect_quantity) : 0.0)`),
                receivedSum: c(`receivedSum + (${val('line.received_quantity')} ? double(line.received_quantity) : 0.0)`),
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'metrics',
    type: 'assignment',
    label: '算 OTD、批次合格率、PPM',
    config: {
      assignments: {
        lineCount: c('double(deliveries.size())'),
        onTimeCount: c(`double(deliveries.filter(d, ${val('d.on_time')} && d.on_time == true).size())`),
        inspectedCount: c(`double(deliveries.filter(d, ${val('d.inspection_result')} && d.inspection_result in ['pass', 'fail', 'concession']).size())`),
        passedCount: c(`double(deliveries.filter(d, ${val('d.inspection_result')} && d.inspection_result == 'pass').size())`),
        // 百分点（98.5 即 98.5%）与 PPM，保留两位小数；评分明细的原始值与指标阈值同一单位
        otdRaw: c(`lineCount > 0.0 ? ${round('100.0 * onTimeCount / lineCount', 2)} : null`),
        lotRaw: c(`inspectedCount > 0.0 ? ${round('100.0 * passedCount / inspectedCount', 2)} : null`),
        ppmRaw: c(`receivedSum > 0.0 ? ${round('defectSum * 1000000.0 / receivedSum', 2)} : null`),
        incomplete: c(`kpis.exists(k, k.method == 'auto' && ${rawOf('k')} == null)`),
      },
    },
  },
  {
    id: 'create_scores',
    type: 'loop',
    label: '按启用指标建评分明细',
    config: {
      collection: c('kpis'),
      iteratorVariable: 'kpi',
      body: {
        nodes: [
          {
            id: 'guard_score',
            type: 'try_catch',
            label: '单条评分明细',
            config: {
              try: {
                nodes: [
                  {
                    id: 'line_raw',
                    type: 'assignment',
                    label: '本项原始值',
                    config: { assignments: { raw: c(rawOf('kpi')) } },
                  },
                  {
                    id: 'create_score',
                    type: 'create_record',
                    label: '建评分明细',
                    config: {
                      objectName: 'srm_performance_score',
                      fields: {
                        review: c('review.id'),
                        kpi: c('kpi.id'),
                        weight: c('kpi.weight'),
                        raw_value: c('raw'),
                        score: c(scoreOf('kpi', 'raw')),
                        scored: c(`kpi.method == 'auto' && raw != null`),
                        comment: c(`kpi.method == 'auto' && raw == null ? '本期没有可用的交付数据，自动指标未算分' : null`),
                      },
                    },
                  },
                ],
                edges: [{ id: 'e_score', source: 'line_raw', target: 'create_score', type: 'default' }],
              },
              // 缺一行的考评单不能往下走：留在「自动算分」，下次运行删掉重建
              catch: { nodes: [{ id: 'score_failed', type: 'assignment', label: '记下失败', config: { assignments: { lineFailed: c('true') } } }] },
            },
          },
        ],
      },
    },
  },
  { id: 'lines_ok', type: 'decision', label: '评分明细齐全？' },
  {
    id: 'to_scoring',
    type: 'update_record',
    label: '写入自动指标，转人工评分',
    config: {
      objectName: 'srm_performance_review',
      filter: { id: c('review.id') },
      fields: {
        // 比率字段存小数（0.985 即 98.5%）
        otd_rate: c(`otdRaw == null ? null : ${round('otdRaw / 100.0', 4)}`),
        lot_pass_rate: c(`lotRaw == null ? null : ${round('lotRaw / 100.0', 4)}`),
        ppm: c('ppmRaw == null ? null : double(round(ppmRaw))'),
        delivery_count: c('lineCount'),
        data_incomplete: c('incomplete'),
        status: 'scoring',
      },
    },
  },
  { id: 'leave_calculating', type: 'assignment', label: '留在自动算分，下次重建' },
  { id: 'skip_vendor', type: 'assignment', label: '不到期、已生成或没有品类' },
  { id: 'next_vendor', type: 'assignment', label: '下一家' },
];

const supplierEdges: Automation.FlowEdge[] = [
  { id: 'v1', source: 'find_grants', target: 'has_grants', type: 'default' },
  { id: 'v_grants', source: 'has_grants', target: 'find_categories', type: 'conditional', condition: c('grants.size() > 0'), label: '有' },
  { id: 'v_no_grants', source: 'has_grants', target: 'skip_vendor', type: 'conditional', condition: c('grants.size() == 0'), label: '没有' },
  { id: 'v2', source: 'find_categories', target: 'classify', type: 'default' },
  { id: 'v3', source: 'classify', target: 'find_existing', type: 'default' },
  { id: 'v4', source: 'find_existing', target: 'is_due', type: 'default' },
  { id: 'v_due', source: 'is_due', target: 'create_review', type: 'conditional', condition: c(`${isDue} && existing == null`), label: '生成' },
  { id: 'v_stale', source: 'is_due', target: 'delete_stale', type: 'conditional', condition: c(`${isDue} && ${stale}`), label: '重建' },
  {
    id: 'v_skip',
    source: 'is_due',
    target: 'skip_vendor',
    type: 'conditional',
    condition: c(`!(${isDue}) || (existing != null && !(${stale}))`),
    label: '跳过',
  },
  { id: 'v_restart', source: 'delete_stale', target: 'create_review', type: 'default' },
  { id: 'v5', source: 'create_review', target: 'find_deliveries', type: 'default' },
  { id: 'v6', source: 'find_deliveries', target: 'reset_sums', type: 'default' },
  { id: 'v7', source: 'reset_sums', target: 'sum_deliveries', type: 'default' },
  { id: 'v8', source: 'sum_deliveries', target: 'metrics', type: 'default' },
  { id: 'v9', source: 'metrics', target: 'create_scores', type: 'default' },
  { id: 'v10', source: 'create_scores', target: 'lines_ok', type: 'default' },
  { id: 'v_lines', source: 'lines_ok', target: 'to_scoring', type: 'conditional', condition: c('!lineFailed'), label: '齐全' },
  { id: 'v_partial', source: 'lines_ok', target: 'leave_calculating', type: 'conditional', condition: c('lineFailed'), label: '有失败' },
  { id: 'v11', source: 'to_scoring', target: 'next_vendor', type: 'default' },
  { id: 'v12', source: 'skip_vendor', target: 'next_vendor', type: 'default' },
  { id: 'v13', source: 'leave_calculating', target: 'next_vendor', type: 'default' },
];

export const PerformanceGenerateFlow: Automation.Flow = {
  name: 'srm_performance_generate',
  label: '生成绩效考评单',
  type: 'schedule',
  status: 'active',
  runAs: 'system',
  // 运行日：定时运行时为空（取今天）；补跑某个月时传入该月的日期
  variables: [{ name: 'asOf', type: 'text', isInput: true, isOutput: false, defaultValue: '' }],

  nodes: [
    { id: 'start', type: 'start', label: '每月 1–7 日', config: { schedule: '0 3 1-7 * *' } },
    {
      id: 'set_dates',
      type: 'assignment',
      label: '运行日与各周期的上一期',
      config: {
        assignments: {
          runDay: c(`asOf != '' ? date(asOf) : today()`),
          thisMonth: c(`date(isoDate(runDay).substring(0, 7) + '-01')`),
          runMonth: c('runDay.getMonth()'),
          periodEnd: c('isoDate(addDays(thisMonth, -1))'),
          startMonthly: c('addMonths(thisMonth, -1)'),
          startQuarterly: c('addMonths(thisMonth, -3)'),
          startYearly: c('addMonths(thisMonth, -12)'),
        },
      },
    },
    {
      id: 'load_kpis',
      type: 'get_record',
      label: '读取启用的指标',
      config: { objectName: 'srm_kpi', filter: { active: true }, limit: 200, outputVariable: 'kpis' },
    },
    { id: 'reset_weight', type: 'assignment', label: '权重合计清零', config: { assignments: { totalWeight: c('0.0') } } },
    {
      id: 'sum_weights',
      type: 'loop',
      label: '合计启用指标权重',
      config: {
        collection: c('kpis'),
        iteratorVariable: 'k',
        body: {
          nodes: [
            {
              id: 'add_weight',
              type: 'assignment',
              label: '累加',
              config: { assignments: { totalWeight: c(`totalWeight + (${val('k.weight')} ? double(k.weight) : 0.0)`) } },
            },
          ],
        },
      },
    },
    { id: 'weights_ok', type: 'decision', label: '权重合计 100%？' },
    {
      id: 'load_directors',
      type: 'get_record',
      label: '读取采购总监',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_procurement_director' }, limit: 50, outputVariable: 'directors' },
    },
    {
      id: 'weight_pct',
      type: 'assignment',
      label: '权重合计（%）',
      config: { assignments: { weightPct: c(`string(${round('totalWeight * 100.0', 2)})`) } },
    },
    {
      id: 'notify_weights',
      type: 'notify',
      label: '通知采购总监',
      config: {
        recipients: [c('directors.map(p, p.user_id)')],
        title: '本期绩效考评单未生成：启用指标权重合计不是 100%',
        message: '指标库中启用指标的权重合计为 {{ weightPct }}%，应为 100%。请在「绩效指标 / 启用指标」调整权重后，由系统管理员补跑考评生成。',
        severity: 'warning',
      },
    },
    {
      id: 'load_vendors',
      type: 'get_record',
      label: '读取活跃供应商',
      config: {
        objectName: 'srm_supplier',
        filter: { status: { $in: ['qualified', 'frozen'] } },
        fields: ['id'],
        limit: 20000,
        outputVariable: 'vendors',
      },
    },
    {
      id: 'each_vendor',
      type: 'loop',
      label: '逐家供应商',
      config: {
        collection: c('vendors'),
        iteratorVariable: 'vendor',
        body: {
          nodes: [
            {
              id: 'guard_vendor',
              type: 'try_catch',
              label: '单家供应商',
              config: {
                try: { nodes: supplierBody, edges: supplierEdges },
                catch: { nodes: [{ id: 'skip_error', type: 'assignment', label: '跳过该供应商' }] },
              },
            },
          ],
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'set_dates', type: 'default' },
    { id: 'e2', source: 'set_dates', target: 'load_kpis', type: 'default' },
    { id: 'e3', source: 'load_kpis', target: 'reset_weight', type: 'default' },
    { id: 'e4', source: 'reset_weight', target: 'sum_weights', type: 'default' },
    { id: 'e5', source: 'sum_weights', target: 'weights_ok', type: 'default' },
    {
      id: 'e_ok',
      source: 'weights_ok',
      target: 'load_vendors',
      type: 'conditional',
      condition: c('kpis.size() > 0 && abs(totalWeight - 1.0) < 0.0001'),
      label: '是',
    },
    {
      id: 'e_bad',
      source: 'weights_ok',
      target: 'load_directors',
      type: 'conditional',
      condition: c('!(kpis.size() > 0 && abs(totalWeight - 1.0) < 0.0001)'),
      label: '否',
    },
    { id: 'e6', source: 'load_directors', target: 'weight_pct', type: 'default' },
    { id: 'e7', source: 'weight_pct', target: 'notify_weights', type: 'default' },
    { id: 'e8', source: 'notify_weights', target: 'end', type: 'default' },
    { id: 'e9', source: 'load_vendors', target: 'each_vendor', type: 'default' },
    { id: 'e10', source: 'each_vendor', target: 'end', type: 'default' },
  ],
};
