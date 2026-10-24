import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, DeliveryRecord, Kpi, Material, PerformanceReview, PerformanceScore, Supplier, SupplierCategory } from '../src/core/objects';
import { CYCLE } from '../src/core/flows/performance/generate.flow';

// v0.5 P2 考评单生成与自动算分（02 §4.7、§5.7，03 §10 第 1–2 步，FR-702，07 R7、R9）：按供应商所供最高物资类别
// 定周期，每期第一个月生成上期考评单并按启用指标建评分明细；OTD、批次合格率、PPM 从交付记录汇总，口径同
// srm_delivery_metrics；没有交付记录时标记数据不全而不给零分；跑两遍不重复建；权重合计不是 100% 时不生成。
// 运行日用 asOf 指定，测试数据全部在这里生成（示例公司名、示例品类），期间取 2030 年起，不与样例表格的 2026-09 混在一起。
type Row = Record<string, unknown>;

describe('performance review generation', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (position: string) => {
    const token = await stack.signUp(`perf-${position}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const systemUpdate = (object: string, doc: Row) => stack.hooks.run(object, 'update', doc, { system: true });

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，与部署时打开开关一致
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  const generate = async (asOf: string) => {
    const run = await stack.flows.run('srm_performance_generate', { asOf }, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const reviewsOf = async (supplier: string) =>
    (await stack.rows(PerformanceReview.name, { supplier })).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const linesOf = async (review: string) => {
    const lines = await stack.rows(PerformanceScore.name, { review });
    return Object.fromEntries(lines.map((line) => [codes.get(String(line.kpi))!, line]));
  };

  let codes: Map<string, string>;
  let material: string;
  const category = async (materialClass: string) => {
    const n = ++seq;
    return (await system(Category.name, { code: `PERF${n}`, name: `示例绩效品类 ${n}`, material_class: materialClass })).id;
  };
  // 存量导入的合格供应商，带若干品类资格
  const vendor = async (categories: string[], status = 'qualified') => {
    const n = ++seq;
    const { id } = await system(Supplier.name, {
      name: `示例绩效测试有限公司 ${n}`,
      credit_code: `91000000MA0PRF${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    for (const c of categories) await system(SupplierCategory.name, { supplier: id, category: c, status: 'qualified' });
    if (status !== 'qualified') await systemUpdate(Supplier.name, { id, status });
    return id;
  };
  const deliver = (supplier: string, doc: Row) =>
    system(DeliveryRecord.name, {
      erp_receipt_no: `PRF${String(++seq).padStart(7, '0')}`,
      erp_order_no: '4500090001',
      erp_line_no: '10',
      supplier,
      material,
      required_date: doc.receipt_date,
      received_quantity: 1000,
      inspection_result: 'pass',
      ...doc,
    });

  let classA: string;
  let classB: string;
  let classC: string;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    codes = new Map((await stack.rows(Kpi.name, {})).map((k) => [String(k.id), String(k.code)]));
    material = (await system(Material.name, { erp_material_no: 'PRF-0001', material_code: 'PRF-0001', name: '示例绩效物料' })).id;
    classA = await category('class_a');
    classB = await category('class_b');
    classC = await category('class_c');
  }, 60_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('takes the cycle per material class from the parameter', () => {
    const yaml = readFileSync(new URL('../params/core.yaml', import.meta.url), 'utf8');
    const block = yaml.split(/\n(?=\S)/).find((b) => b.startsWith('perf_cycle:'))!;
    const example = Object.fromEntries(
      /example:\s*\{([^}]*)\}/.exec(block)![1]!.split(',').map((pair) => pair.split(':').map((s) => s.trim()) as [string, string]),
    );
    const words = { monthly: '每月', quarterly: '每季度', yearly: '每年' } as const;
    expect({ A: words[CYCLE.class_a], B: words[CYCLE.class_b], C: words[CYCLE.class_c] }).toEqual(example);
  });

  describe('cycles', () => {
    let monthly: string;
    let quarterly: string;
    let yearly: string;
    let frozen: string;
    let potential: string;
    let noGrants: string;

    beforeAll(async () => {
      monthly = await vendor([classA, classC]);
      quarterly = await vendor([classB, classC]);
      yearly = await vendor([classC]);
      frozen = await vendor([classA], 'frozen');
      potential = (await system(Supplier.name, { name: `示例潜在供应商 ${++seq}`, credit_code: `91000000MA0PRF${String(++seq).padStart(4, '0')}` })).id;
      await system(SupplierCategory.name, { supplier: potential, category: classA, status: 'trial' });
      noGrants = await vendor([]);
      await generate('2031-01-03');
    }, 60_000);

    it('generates last period\'s review for every class whose period starts this month, then moves it to scoring', async () => {
      expect(await reviewsOf(monthly)).toMatchObject([
        { cycle: 'monthly', period: '2030-12', period_start: '2030-12-01', period_end: '2030-12-31', status: 'scoring' },
      ]);
      expect(await reviewsOf(quarterly)).toMatchObject([
        { cycle: 'quarterly', period: '2030Q4', period_start: '2030-10-01', period_end: '2030-12-31', status: 'scoring' },
      ]);
      expect(await reviewsOf(yearly)).toMatchObject([
        { cycle: 'yearly', period: '2030', period_start: '2030-01-01', period_end: '2030-12-31', status: 'scoring' },
      ]);
      expect((await reviewsOf(monthly))[0]!.review_no).toMatch(/^PR\d{9}$/);
    });

    it('includes frozen suppliers and skips inactive ones and those without a category', async () => {
      expect(await reviewsOf(frozen)).toMatchObject([{ period: '2030-12' }]);
      expect(await reviewsOf(potential)).toHaveLength(0);
      expect(await reviewsOf(noGrants)).toHaveLength(0);
    });

    it('builds one score line per active KPI with the weight snapshot', async () => {
      const kpis = await stack.rows(Kpi.name, { active: true });
      const lines = await linesOf(String((await reviewsOf(quarterly))[0]!.id));
      expect(Object.keys(lines).sort()).toEqual(kpis.map((k) => String(k.code)).sort());
      for (const k of kpis) expect(lines[String(k.code)]!.weight).toBeCloseTo(Number(k.weight), 6);
      expect(lines.ACK_ON_TIME).toBeUndefined();
    });

    it('creates nothing new when run again, and only monthly reviews outside the first month of a quarter or year', async () => {
      await generate('2031-01-05');
      for (const id of [monthly, quarterly, yearly, frozen]) expect(await reviewsOf(id)).toHaveLength(1);

      await generate('2031-02-02');
      expect((await reviewsOf(monthly)).map((r) => r.period)).toEqual(['2030-12', '2031-01']);
      expect(await reviewsOf(quarterly)).toHaveLength(1);
      expect(await reviewsOf(yearly)).toHaveLength(1);
    });
  });

  describe('automatic scoring', () => {
    let supplier: string;
    let quarterly: string;
    let idle: string;

    beforeAll(async () => {
      supplier = await vendor([classA]);
      // 2032-06：10 行，9 行准时；9 行合格、1 行不合格；实收 10,000，不良 3
      for (let i = 0; i < 10; i++) {
        await deliver(supplier, {
          receipt_date: '2032-06-10',
          required_date: i === 0 ? '2032-06-05' : '2032-06-12',
          inspection_result: i === 1 ? 'fail' : 'pass',
          severity: i === 1 ? 'minor' : undefined,
          defect_quantity: i === 1 ? 2 : i === 2 ? 1 : undefined,
        });
      }
      // 上月的不计入
      await deliver(supplier, { receipt_date: '2032-05-31', required_date: '2032-05-01', inspection_result: 'fail', severity: 'major', defect_quantity: 500 });

      // 季度：7 月、9 月各一行，8 月一行让步接收；未检行不进合格率分母
      quarterly = await vendor([classB]);
      await deliver(quarterly, { receipt_date: '2032-07-03' });
      await deliver(quarterly, { receipt_date: '2032-08-15', inspection_result: 'concession', defect_quantity: 10 });
      await deliver(quarterly, { receipt_date: '2032-09-30', inspection_result: 'not_inspected' });

      idle = await vendor([classA]);
      await generate('2032-07-01');
    }, 60_000);

    it('writes OTD, lot acceptance rate and PPM from the period\'s delivery records', async () => {
      const [review] = await reviewsOf(supplier);
      expect(review).toMatchObject({ period: '2032-06', delivery_count: 10, data_incomplete: false, status: 'scoring' });
      expect(review!.otd_rate).toBeCloseTo(0.9, 6);
      expect(review!.lot_pass_rate).toBeCloseTo(0.9, 6);
      expect(review!.ppm).toBe(300);
      expect(review!.ack_on_time_rate ?? null).toBeNull();
    });

    it('scores automatic KPIs linearly between their zero and full values and leaves manual ones to scorers', async () => {
      const lines = await linesOf(String((await reviewsOf(supplier))[0]!.id));
      // OTD 90%：满分 98、零分 78 → 60；批次合格率 90%：满分 99、零分 89 → 10；PPM 300：满分 100、零分 5000 → 95.92
      expect(lines.OTD).toMatchObject({ raw_value: 90, score: 60, scored: true });
      expect(lines.LOT_PASS).toMatchObject({ raw_value: 90, score: 10, scored: true });
      expect(lines.PPM).toMatchObject({ raw_value: 300, scored: true });
      expect(lines.PPM!.score).toBeCloseTo(95.92, 2);
      for (const code of ['PLAN_FULFIL', 'PRICE', 'SERVICE', 'SAFETY_ENV']) {
        expect(lines[code]).toMatchObject({ scored: false });
        expect(lines[code]!.score ?? null).toBeNull();
      }
    });

    it('sums a quarter over its three months', async () => {
      const [review] = await reviewsOf(quarterly);
      expect(review).toMatchObject({ period: '2032Q2' });
      // 2032-07-01 生成的是二季度；三季度的交付等 10 月生成
      expect(review!.delivery_count).toBe(0);
      await generate('2032-10-04');
      const q3 = (await reviewsOf(quarterly)).find((r) => r.period === '2032Q3')!;
      expect(q3).toMatchObject({ delivery_count: 3, data_incomplete: false });
      expect(q3.otd_rate).toBeCloseTo(1, 6);
      expect(q3.lot_pass_rate).toBeCloseTo(0.5, 6);
      expect(q3.ppm).toBeCloseTo(3333, 0);
    });

    it('marks a period without delivery records as incomplete instead of scoring zero', async () => {
      const [review] = await reviewsOf(idle);
      expect(review).toMatchObject({ period: '2032-06', delivery_count: 0, data_incomplete: true, status: 'scoring' });
      expect(review!.otd_rate ?? null).toBeNull();
      const lines = await linesOf(String(review!.id));
      for (const code of ['OTD', 'LOT_PASS', 'PPM']) {
        expect(lines[code]).toMatchObject({ scored: false });
        expect(lines[code]!.score ?? null).toBeNull();
        expect(String(lines[code]!.comment)).toContain('交付');
      }
    });
  });

  // 门槛 1 第 6 步前半：考评单上的三项自动指标与导入的交付记录一致（同数据集 srm_delivery_metrics 的口径）
  describe('imported sample', () => {
    type Described = { name: string; fields: Record<string, { label?: unknown }> };
    const sample = (file: string) => readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
    const importAs = async (token: string, object: Described, csv: string, matchFields: string[], skipBlankMatchKey = false) => {
      const mapping = Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name]));
      const res = await stack.apiAs(token, 'POST', `/data/${object.name}/import`, { format: 'csv', csv, mapping, writeMode: 'upsert', matchFields, skipBlankMatchKey });
      const body = (await res.json()) as { errors: number; data?: { errors: number } };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect((body.data ?? body).errors, JSON.stringify(body)).toBe(0);
    };
    let sqe: string;

    beforeAll(async () => {
      const admin = (await person('srm_admin')).token;
      sqe = (await person('srm_sqe')).token;
      await importAs(admin, Material, sample('srm_material.csv'), ['erp_material_no']);
      await importAs(admin, Supplier, sample('srm_supplier.csv'), ['credit_code'], true);
      await importAs(admin, Supplier, sample('srm_supplier.csv'), ['country', 'registration_no'], true);
      await importAs(sqe, DeliveryRecord, sample('srm_delivery_record.csv'), ['erp_receipt_no', 'erp_order_no', 'erp_line_no']);
      // 样例供应商都按 A 类（月度）考评
      for (const row of await stack.rows(Supplier.name, { status: 'qualified' })) {
        if ((await stack.rows(SupplierCategory.name, { supplier: row.id })).length === 0) {
          await system(SupplierCategory.name, { supplier: row.id, category: classA, status: 'qualified' });
        }
      }
      await generate('2026-10-02');
    }, 120_000);

    it('matches the delivery metrics dataset for every supplier delivering in the period', async () => {
      const res = await stack.apiAs(sqe, 'POST', '/analytics/dataset/query', {
        datasetName: 'srm_delivery_metrics',
        selection: { dimensions: ['period', 'supplier'], measures: ['line_count', 'otd_rate', 'lot_pass_rate', 'ppm'] },
      });
      const body = (await res.json()) as { rows: Array<Record<string, number | string | null>> };
      expect(res.status, JSON.stringify(body)).toBe(200);
      const names = new Map((await stack.rows(Supplier.name, {})).map((r) => [String(r.name), String(r.id)]));

      let compared = 0;
      for (const metric of body.rows.filter((r) => r.period === '2026-09')) {
        const supplier = names.get(String(metric.supplier)) ?? String(metric.supplier);
        const review = (await reviewsOf(supplier)).find((r) => r.period === '2026-09');
        if ((await stack.rows(Supplier.name, { id: supplier }))[0]!.status !== 'qualified') {
          expect(review, String(metric.supplier)).toBeUndefined();
          continue;
        }
        expect(review, String(metric.supplier)).toBeTruthy();
        expect(review!.delivery_count).toBe(metric.line_count);
        expect(Number(review!.otd_rate)).toBeCloseTo(Number(metric.otd_rate), 4);
        if (metric.lot_pass_rate == null) {
          expect(review!.lot_pass_rate ?? null).toBeNull();
          expect(review!.data_incomplete).toBe(true);
        } else {
          expect(Number(review!.lot_pass_rate)).toBeCloseTo(Number(metric.lot_pass_rate), 4);
        }
        expect(Number(review!.ppm)).toBeCloseTo(Number(metric.ppm ?? 0), 0);
        compared++;
      }
      expect(compared).toBeGreaterThanOrEqual(6);
    });
  });

  describe('guards', () => {
    it('generates nothing and tells the procurement director when active weights do not add up to 100%', async () => {
      const director = await person('srm_procurement_director');
      const supplier = await vendor([classA]);
      const [service] = await stack.rows(Kpi.name, { code: 'SERVICE' });
      await systemUpdate(Kpi.name, { id: service!.id, active: false });
      try {
        await generate('2033-03-02');
        expect(await reviewsOf(supplier)).toHaveLength(0);
        const notice = async () =>
          (await stack.rows('sys_notification', {})).find((n) => String((n.payload as Row | undefined)?.title).includes('权重合计'));
        await expect.poll(notice).toBeTruthy();
        expect(String(((await notice())!.payload as Row).body)).toContain('90%');
        await expect.poll(async () => JSON.stringify(await stack.rows('sys_notification_receipt', { notification_id: (await notice())!.id }))).toContain(director.id);
      } finally {
        await systemUpdate(Kpi.name, { id: service!.id, active: true });
      }
      await generate('2033-03-02');
      expect(await reviewsOf(supplier)).toMatchObject([{ period: '2033-02', status: 'scoring' }]);
    });

    it('rebuilds a review a failed run left in auto scoring', async () => {
      const supplier = await vendor([classA]);
      const stale = await system(PerformanceReview.name, { supplier, cycle: 'monthly', period: '2033-04', status: 'calculating' });
      await generate('2033-05-01');
      const [review] = await reviewsOf(supplier);
      expect(review).toMatchObject({ period: '2033-04', status: 'scoring' });
      expect(review!.id).not.toBe(stale.id);
      expect(await stack.rows(PerformanceReview.name, { id: stale.id })).toHaveLength(0);
      expect(Object.keys(await linesOf(String(review!.id)))).toHaveLength(7);
    });

    it('refuses a second review for the same supplier and period', async () => {
      const supplier = await vendor([classA]);
      await system(PerformanceReview.name, { supplier, cycle: 'monthly', period: '2033-06', status: 'calculating' });
      await expect(system(PerformanceReview.name, { supplier, cycle: 'monthly', period: '2033-06', status: 'calculating' })).rejects.toBeTruthy();
    });

    it('keeps reviews read-only for internal positions; only the SRM admin deletes', async () => {
      const supplier = await vendor([classA]);
      await generate('2033-08-01');
      const [review] = await reviewsOf(supplier);
      for (const position of ['srm_procurement_director', 'srm_buyer', 'srm_sqe', 'srm_category_manager', 'srm_general_manager']) {
        const { token } = await person(position);
        expect(await stack.rows(PerformanceReview.name, { id: review!.id }, { as: token })).toHaveLength(1);
        expect((await stack.rows(PerformanceScore.name, { review: review!.id }, { as: token })).length).toBe(7);
        await expect(stack.hooks.run(PerformanceReview.name, 'update', { id: review!.id, total_score: 99 }, { as: token })).rejects.toBeTruthy();
        await expect(
          stack.hooks.run(PerformanceReview.name, 'insert', { supplier, cycle: 'monthly', period: '2033-09' }, { as: token }),
        ).rejects.toBeTruthy();
      }
      const admin = await person('srm_admin');
      await expect(stack.hooks.run(PerformanceReview.name, 'update', { id: review!.id, total_score: 99 }, { as: admin.token })).rejects.toBeTruthy();
      await stack.hooks.run(PerformanceReview.name, 'delete', { id: review!.id }, { as: admin.token });
      expect(await stack.rows(PerformanceReview.name, { id: review!.id })).toHaveLength(0);
      expect(await stack.rows(PerformanceScore.name, { review: review!.id })).toHaveLength(0);
    });
  });
});
