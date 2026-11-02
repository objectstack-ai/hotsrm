import type * as Automation from '@objectstack/spec/automation';

// 年度审核计划（03 §13，FR-607；WI-01 6.9）：按供应商所供品类中最高的物资类别（srm_category.material_class，
// P-D2）定复审频次，为本年内到期的合格供应商各生成一条「计划中」的年度审核，计划日期 = 上次完成审核的日期 +
// 频次（已过期的取今天；从没审核过的取今天），审核员默认为品类的 SQE。日历视图按计划日期排程。
// 频次取 params/core.yaml 的 annual_audit_frequency（示例：A 类 12 个月、B 类 24 个月、C 类不定期，不生成），
// 客户改参数时同步 FREQUENCY。
//
// 每月 1 日跑一次，年初那次生成全年计划，之后各次补上漏掉的和年中新到期的（03 §2.3 R2）：供应商已有「计划中」
// 的审核、或已有本年度生成的年度审核（不论完成还是取消）时跳过，跑两遍不重复建。先处理 A 类品类、再处理 B 类，
// 同时供应 A、B 两类的供应商按 A 类频次生成。不需要现场复审的 B 类供应商由质量部门取消并写明原因（WI-01 6.9）。
const FREQUENCY = { class_a: 12, class_b: 24 } as const;

const year = `planYear`;
const yearEnd = `timestamp(string(today().getFullYear()) + '-12-31T00:00:00Z')`;

const pass = (cls: keyof typeof FREQUENCY): Automation.FlowNode[] => {
  const k = cls === 'class_a' ? 'A' : 'B';
  const months = FREQUENCY[cls];
  const cat = `cat${k}`;
  const grant = `grant${k}`;
  const prior = `prior${k}`;
  // 最近一次完成的审核日期；没有时为 null
  const last = `(${prior}.size() == 0 ? null : ${prior}.filter(a, ${prior}.all(b, string(b.audit_date) <= string(a.audit_date)))[0].audit_date)`;
  const due = `addMonths(${last}, ${months})`;
  const isDue =
    `vendor${k} != null && vendor${k}.status == 'qualified' && planned${k} == null && thisYear${k} == null`
    + ` && (${prior}.size() == 0 || ${due} <= ${yearEnd})`;
  const plannedDate = `isoDate(${prior}.size() == 0 || ${due} < today() ? today() : ${due})`;
  const c = (source: string) => ({ dialect: 'cel' as const, source });

  return [
    {
      id: `find_categories_${k}`,
      type: 'get_record',
      label: `读取 ${k} 类品类`,
      config: { objectName: 'srm_category', filter: { material_class: cls }, limit: 500, outputVariable: `categories${k}` },
    },
    {
      id: `each_category_${k}`,
      type: 'loop',
      label: `逐个 ${k} 类品类`,
      config: {
        collection: c(`categories${k}`),
        iteratorVariable: cat,
        body: {
          nodes: [
            {
              id: `guard_category_${k}`,
              type: 'try_catch',
              label: '单个品类',
              config: {
                try: {
                  nodes: [
                    {
                      id: `find_grants_${k}`,
                      type: 'get_record',
                      label: '读取有效的品类资格',
                      config: {
                        objectName: 'srm_supplier_category',
                        filter: { category: c(`${cat}.id`), status: { $in: ['qualified', 'trial'] } },
                        limit: 2000,
                        outputVariable: `grants${k}`,
                      },
                    },
                    {
                      id: `each_grant_${k}`,
                      type: 'loop',
                      label: '逐家供应商',
                      config: {
                        collection: c(`grants${k}`),
                        iteratorVariable: grant,
                        body: {
                          nodes: [
                            {
                              id: `guard_${k}`,
                              type: 'try_catch',
                              label: '单家供应商',
                              config: {
                                try: {
                                  nodes: [
                                    {
                                      id: `load_vendor_${k}`,
                                      type: 'get_record',
                                      label: '读取供应商',
                                      config: { objectName: 'srm_supplier', filter: { id: c(`${grant}.supplier`) }, outputVariable: `vendor${k}` },
                                    },
                                    {
                                      id: `find_planned_${k}`,
                                      type: 'get_record',
                                      label: '已有计划中的审核？',
                                      config: {
                                        objectName: 'srm_supplier_audit',
                                        filter: { supplier: c(`${grant}.supplier`), status: 'planned' },
                                        outputVariable: `planned${k}`,
                                      },
                                    },
                                    {
                                      id: `find_this_year_${k}`,
                                      type: 'get_record',
                                      label: '本年度已生成？',
                                      config: {
                                        objectName: 'srm_supplier_audit',
                                        filter: { supplier: c(`${grant}.supplier`), audit_type: 'annual', plan_year: c(year) },
                                        outputVariable: `thisYear${k}`,
                                      },
                                    },
                                    {
                                      id: `find_prior_${k}`,
                                      type: 'get_record',
                                      label: '读取已完成的审核',
                                      config: {
                                        objectName: 'srm_supplier_audit',
                                        filter: { supplier: c(`${grant}.supplier`), status: 'done' },
                                        limit: 200,
                                        outputVariable: prior,
                                      },
                                    },
                                    { id: `due_${k}`, type: 'decision', label: '本年到期？' },
                                    {
                                      id: `create_plan_${k}`,
                                      type: 'create_record',
                                      label: '生成年度审核',
                                      config: {
                                        objectName: 'srm_supplier_audit',
                                        fields: {
                                          supplier: c(`${grant}.supplier`),
                                          audit_type: 'annual',
                                          plan_year: c(year),
                                          planned_date: c(plannedDate),
                                          status: 'planned',
                                          auditors: c(`has(${cat}.sqe) && ${cat}.sqe != null ? [${cat}.sqe] : []`),
                                        },
                                      },
                                    },
                                    { id: `skip_${k}`, type: 'assignment', label: '不到期或已安排' },
                            { id: `next_${k}`, type: 'assignment', label: '下一家' },
                                  ],
                                  edges: [
                                    { id: `e_${k}1`, source: `load_vendor_${k}`, target: `find_planned_${k}`, type: 'default' },
                                    { id: `e_${k}2`, source: `find_planned_${k}`, target: `find_this_year_${k}`, type: 'default' },
                                    { id: `e_${k}3`, source: `find_this_year_${k}`, target: `find_prior_${k}`, type: 'default' },
                                    { id: `e_${k}4`, source: `find_prior_${k}`, target: `due_${k}`, type: 'default' },
                                    { id: `e_${k}_due`, source: `due_${k}`, target: `create_plan_${k}`, type: 'conditional', condition: c(isDue), label: '到期' },
                                    { id: `e_${k}_skip`, source: `due_${k}`, target: `skip_${k}`, type: 'conditional', condition: c(`!(${isDue})`), label: '跳过' },
                            { id: `e_${k}5`, source: `create_plan_${k}`, target: `next_${k}`, type: 'default' },
                            { id: `e_${k}6`, source: `skip_${k}`, target: `next_${k}`, type: 'default' },
                                  ],
                                },
                                // 单家失败不影响整次生成
                                catch: { nodes: [{ id: `skip_error_${k}`, type: 'assignment', label: '跳过该供应商' }] },
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                  edges: [{ id: `e_${k}_grants`, source: `find_grants_${k}`, target: `each_grant_${k}`, type: 'default' }],
                },
                catch: { nodes: [{ id: `skip_category_${k}`, type: 'assignment', label: '跳过该品类' }] },
              },
            },
          ],
        },
      },
    },
  ];
};

export const AuditPlanGenerateFlow: Automation.Flow = {
  name: 'srm_audit_plan_generate',
  label: '生成年度审核计划',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每月 1 日', config: { schedule: '30 2 1 * *' } },
    {
      id: 'set_year',
      type: 'assignment',
      label: '本年度',
      config: { assignments: { planYear: { dialect: 'cel', source: 'double(today().getFullYear())' } } },
    },
    ...pass('class_a'),
    ...pass('class_b'),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'set_year', type: 'default' },
    { id: 'e1', source: 'set_year', target: 'find_categories_A', type: 'default' },
    { id: 'e2', source: 'find_categories_A', target: 'each_category_A', type: 'default' },
    { id: 'e3', source: 'each_category_A', target: 'find_categories_B', type: 'default' },
    { id: 'e4', source: 'find_categories_B', target: 'each_category_B', type: 'default' },
    { id: 'e5', source: 'each_category_B', target: 'end', type: 'default' },
  ],
};
