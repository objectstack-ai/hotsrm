import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, DeliveryRecord, Material, PerformanceReview, PerformanceScore, Supplier, SupplierCategory } from '../src/core/objects';

// 07 R9：考评生成在一个 flow 里逐家处理，先量 200 家供应商（每家 1–2 个品类、本月 6 行交付记录）一次生成的耗时。
// 结果记在 03 §10；数据量大、耗时长，默认不跑：SRM_LOAD_TEST=1 pnpm vitest run test/performance-generate-load.test.ts
const SUPPLIERS = Number(process.env.SRM_LOAD_SUPPLIERS ?? 200);
const LINES = Number(process.env.SRM_LOAD_LINES ?? 6);

describe.skipIf(!process.env.SRM_LOAD_TEST)('performance review generation load', () => {
  let stack: VerifyStack;
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  const system = async (object: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    const material = (await system(Material.name, { erp_material_no: 'LOAD-0001', material_code: 'LOAD-0001', name: '示例负载物料' })).id;
    const a = (await system(Category.name, { code: 'LOAD_A', name: '示例负载 A 类品类', material_class: 'class_a' })).id;
    const c = (await system(Category.name, { code: 'LOAD_C', name: '示例负载 C 类品类', material_class: 'class_c' })).id;
    for (let n = 0; n < SUPPLIERS; n++) {
      const { id } = await system(Supplier.name, {
        name: `示例负载测试有限公司 ${n}`,
        credit_code: `91000000MA0LD${String(n).padStart(5, '0')}`,
        legacy_imported: true,
      });
      await system(SupplierCategory.name, { supplier: id, category: a, status: 'qualified' });
      if (n % 2 === 0) await system(SupplierCategory.name, { supplier: id, category: c, status: 'qualified' });
      for (let i = 0; i < LINES; i++) {
        await system(DeliveryRecord.name, {
          erp_receipt_no: `LD${n}-${i}`,
          erp_order_no: '4500070001',
          erp_line_no: '10',
          supplier: id,
          material,
          required_date: '2034-03-10',
          receipt_date: i === 0 ? '2034-03-12' : `2034-03-${String(1 + (i % 28)).padStart(2, '0')}`,
          received_quantity: 500,
          inspection_result: 'pass',
          defect_quantity: i === 1 ? 1 : undefined,
        });
      }
    }
  }, 1_800_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it(`generates and scores ${SUPPLIERS} monthly reviews in one run`, async () => {
    const started = Date.now();
    const run = await stack.flows.run('srm_performance_generate', { asOf: '2034-04-01' }, { system: true });
    const first = Date.now() - started;
    expect(run.success, JSON.stringify(run).slice(0, 2000)).toBe(true);
    const reviews = await stack.rows(PerformanceReview.name, { period: '2034-03' });
    expect(reviews).toHaveLength(SUPPLIERS);
    expect(reviews.every((r) => r.status === 'scoring' && r.delivery_count === LINES)).toBe(true);
    expect((await stack.rows(PerformanceScore.name, {})).length).toBe(SUPPLIERS * 7);

    const again = Date.now();
    await stack.flows.run('srm_performance_generate', { asOf: '2034-04-02' }, { system: true });
    const rerun = Date.now() - again;
    expect(await stack.rows(PerformanceReview.name, { period: '2034-03' })).toHaveLength(SUPPLIERS);
    console.log(`[load] ${SUPPLIERS} suppliers × ${LINES} lines: first run ${first} ms, rerun ${rerun} ms`);
  }, 1_800_000);
});
