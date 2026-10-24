import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { DeliveryRecord, Material, Supplier } from '../src/core/objects';

// v0.4 Q1 交付记录（02 §4.6，03 §8，05 §4.1）：准时按承诺日期判定、没有承诺日期按需求日期；期间取实到月份；
// 检验结论与不良数的约束；录入权限；按供应商、期间出 OTD、批次合格率、PPM；模拟「脏」交付表格的试导结果
// （data/samples/delivery-trial/，结论写在 docs/implementation/delivery-import.md §5）。
describe('delivery record', () => {
  let stack: VerifyStack;
  let seq = 0;
  let admin: string;
  let sqe: string;
  let buyer: string;
  let supplierId: string;
  let materialId: string;

  type Row = { row: number; ok: boolean; action: string; code?: string; field?: string; error?: string };
  type ImportResult = { total: number; created: number; updated: number; errors: number; results: Row[] };
  type Described = { name: string; fields: Record<string, { label?: unknown }> };

  const sample = (file: string) => readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
  const mappingFor = (object: Described) => Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name]));
  const person = async (position: string) => {
    const token = await stack.signUp(`dr-${position}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };
  const importAs = async (token: string, object: Described, csv: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(token, 'POST', `/data/${object.name}/import`, {
      format: 'csv',
      csv,
      mapping: mappingFor(object),
      writeMode: 'upsert',
      matchFields,
      skipBlankMatchKey,
    });
    const body = (await res.json()) as ImportResult & { data?: ImportResult };
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.data ?? body;
  };
  const deliveryKey = ['erp_receipt_no', 'erp_order_no', 'erp_line_no'];
  const importDeliveries = (csv: string, token = sqe) => importAs(token, DeliveryRecord, csv, deliveryKey);

  const record = (doc: Record<string, unknown>) => ({
    erp_receipt_no: `59${String(++seq).padStart(8, '0')}`,
    erp_order_no: '4500019999',
    erp_line_no: '10',
    supplier: supplierId,
    material: materialId,
    required_date: '2026-09-10',
    receipt_date: '2026-09-10',
    received_quantity: 100,
    ...doc,
  });
  const insert = async (doc: Record<string, unknown>, as = sqe) =>
    (await stack.hooks.run(DeliveryRecord.name, 'insert', record(doc), { as })) as { id: string };
  const get = async (id: string) => (await stack.rows(DeliveryRecord.name, { id }))[0]!;

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await person('srm_admin');
    sqe = await person('srm_sqe');
    buyer = await person('srm_buyer');
    // 样例物料与存量供应商（交付表格里的供应商、物料都来自它们和演示种子）
    await importAs(admin, Material, sample('srm_material.csv'), ['erp_material_no']);
    await importAs(admin, Supplier, sample('srm_supplier.csv'), ['credit_code'], true);
    await importAs(admin, Supplier, sample('srm_supplier.csv'), ['country', 'registration_no'], true);
    supplierId = String((await stack.rows(Supplier.name, { name: '示例电子科技有限公司' }))[0]!.id);
    materialId = String((await stack.rows(Material.name, { erp_material_no: 'EX-100001' }))[0]!.id);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('judges on-time by the promised date, else by the required date', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ promised_date: '2026-09-12', receipt_date: '2026-09-12' }, true], // 当天到货算准时
      [{ promised_date: '2026-09-12', receipt_date: '2026-09-13' }, false],
      [{ required_date: '2026-09-05', promised_date: '2026-09-12', receipt_date: '2026-09-11' }, true], // 承诺晚于需求：按承诺
      [{ required_date: '2026-09-18', promised_date: '2026-09-16', receipt_date: '2026-09-17' }, false], // 承诺早于需求：仍按承诺
      [{ required_date: '2026-09-10', receipt_date: '2026-09-10' }, true], // 没有承诺日期：按需求日期
      [{ required_date: '2026-09-10', receipt_date: '2026-09-11' }, false],
    ];
    for (const [doc, expected] of cases) {
      const row = await get((await insert(doc)).id);
      expect(row.on_time, JSON.stringify(doc)).toBe(expected);
    }
  });

  it('derives the period and on-time flag itself and recomputes them when dates are corrected', async () => {
    const created = await insert({ receipt_date: '2026-09-30', required_date: '2026-09-28', on_time: true, period: '2026-08' });
    let row = await get(created.id);
    expect([row.on_time, row.period]).toEqual([false, '2026-09']);
    expect(row.received_quantity_mn).toBeCloseTo(0.0001, 9);

    await stack.hooks.run(DeliveryRecord.name, 'update', { id: created.id, receipt_date: '2026-10-01', required_date: '2026-10-02' }, { as: sqe });
    row = await get(created.id);
    expect([row.on_time, row.period]).toEqual([true, '2026-10']);
  });

  it('requires severity and defect quantity on nonconforming lots', async () => {
    await expect(insert({ inspection_result: 'fail', defect_quantity: 5 })).rejects.toThrow(/Severity|严重度/);
    await expect(insert({ inspection_result: 'fail', severity: 'major' })).rejects.toThrow(/Defect Quantity|不良数/);
    await expect(insert({ inspection_result: 'concession' })).rejects.toThrow(/Defect Quantity|不良数/);
    await expect(insert({ inspection_result: 'fail', severity: 'minor', defect_quantity: 101 })).rejects.toThrow(/defect quantity|不良数/i);
    await expect(insert({ accepted_quantity: 120 })).rejects.toThrow(/accepted quantity|合格数量/i);
    // AQL 抽检判批合格时仍可能记下少量不良，计入 PPM
    const passed = await get((await insert({ inspection_result: 'pass', defect_quantity: 2 })).id);
    expect([passed.inspection_result, passed.defect_quantity]).toEqual(['pass', 2]);
    // 手工录入不填检验结论时为「未检」
    expect((await get((await insert({})).id)).inspection_result).toBe('not_inspected');
  });

  it('keeps one record per receipt, order and line', async () => {
    const doc = { erp_receipt_no: '5900000001', erp_order_no: '4500019998', erp_line_no: '10' };
    await insert(doc);
    await expect(insert(doc)).rejects.toBeTruthy();
    // 同一订单行分两次到货：收货单号不同，两条都留下
    await insert({ ...doc, erp_receipt_no: '5900000002' });
    expect(await stack.rows(DeliveryRecord.name, { erp_order_no: '4500019998' })).toHaveLength(2);
  });

  it('is read-only for buyers, entered by SQE and IQC, deleted only by the admin', async () => {
    const created = await insert({});
    expect((await stack.rows(DeliveryRecord.name, { id: created.id }, { as: buyer })).length).toBe(1);
    await expect(insert({}, buyer)).rejects.toBeTruthy();
    await expect(stack.hooks.run(DeliveryRecord.name, 'update', { id: created.id, received_quantity: 1 }, { as: buyer })).rejects.toBeTruthy();
    const manager = await person('srm_category_manager');
    await expect(insert({}, manager)).rejects.toBeTruthy();
    const rejected = await importDeliveries(sample('srm_delivery_record.csv'), buyer).catch(() => undefined);
    expect(rejected?.created ?? 0).toBe(0);
    // IQC 检验员逐条录入、更正，不能删除
    const inspector = await person('srm_iqc_inspector');
    const entered = await insert({ inspection_result: 'fail', severity: 'major', defect_quantity: 3 }, inspector);
    await stack.hooks.run(DeliveryRecord.name, 'update', { id: entered.id, defect_quantity: 4 }, { as: inspector });
    expect((await get(entered.id)).defect_quantity).toBe(4);
    await expect(stack.hooks.run(DeliveryRecord.name, 'delete', { id: entered.id }, { as: inspector })).rejects.toBeTruthy();
    // 删除只给系统管理员：导错的行删掉后由 SQE 重导
    await expect(stack.hooks.run(DeliveryRecord.name, 'delete', { id: created.id }, { as: sqe })).rejects.toBeTruthy();
    await stack.hooks.run(DeliveryRecord.name, 'delete', { id: created.id }, { as: admin });
    expect(await stack.rows(DeliveryRecord.name, { id: created.id })).toHaveLength(0);
  });

  describe('monthly sample', () => {
    type MetricRow = Record<string, number | string | null>;
    const metrics = async (dimensions: string[], measures: string[]) => {
      const res = await stack.apiAs(sqe, 'POST', '/analytics/dataset/query', { datasetName: 'srm_delivery_metrics', selection: { dimensions, measures } });
      const body = (await res.json()) as { rows: MetricRow[] };
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body.rows;
    };

    beforeAll(async () => {
      // 上面用例写入的行都在订单 45000199xx 下，先清掉，免得混进样例月份的统计
      for (const row of await stack.rows(DeliveryRecord.name, {})) {
        await stack.hooks.run(DeliveryRecord.name, 'delete', { id: row.id }, { system: true });
      }
      const result = await importDeliveries(sample('srm_delivery_record.csv'));
      expect([result.created, result.errors], JSON.stringify(result)).toEqual([15, 0]);
    });

    it('marks each receipt on time or late', async () => {
      const rows = await stack.rows(DeliveryRecord.name, { period: '2026-09' });
      const late = rows.filter((r) => r.on_time === false).map((r) => r.erp_receipt_no).sort();
      expect(late).toEqual(['5000080016', '5000080042', '5000080064', '5000080071', '5000080098', '5000080112']);
      expect(rows.filter((r) => r.on_time === true)).toHaveLength(9);
    });

    it('gives OTD, lot acceptance rate and PPM by supplier and period', async () => {
      const rows = await metrics(
        ['period', 'supplier'],
        ['line_count', 'on_time_count', 'otd_rate', 'inspected_count', 'passed_count', 'lot_pass_rate', 'defect_sum', 'received_sum', 'ppm'],
      );
      const by = Object.fromEntries(rows.filter((r) => r.period === '2026-09').map((r) => [String(r.supplier), r]));
      const pick = (name: string) => {
        const r = by[name]!;
        return [r.line_count, r.on_time_count, r.inspected_count, r.passed_count, r.defect_sum ?? 0, r.received_sum];
      };
      // [交付行, 准时行, 已检行, 合格行, 不良数, 实收数]
      expect(pick('示例电子科技有限公司')).toEqual([5, 3, 5, 4, 1200, 120000]);
      expect(pick('示例电子材料有限公司')).toEqual([2, 1, 2, 1, 40, 10000]); // 让步接收计为不合格批
      expect(pick('Example Sensor Co. Ltd.')).toEqual([2, 1, 2, 1, 2000, 4000]);
      expect(pick('示例精密五金有限公司')).toEqual([2, 1, 2, 1, 8, 2000]);
      expect(pick('示例包装制品有限公司')).toEqual([2, 1, 0, 0, 0, 3400]); // 未检不进合格率分母
      expect(pick('Example Fasteners Inc.')).toEqual([1, 1, 1, 1, 0, 600]);
      expect(pick('示例工业品商贸有限公司')).toEqual([1, 1, 0, 0, 0, 50]);

      const elec = by['示例电子科技有限公司']!;
      expect(elec.otd_rate).toBeCloseTo(0.6, 6);
      expect(elec.lot_pass_rate).toBeCloseTo(0.8, 6);
      expect(elec.ppm).toBeCloseTo(10000, 3);
      expect(by['Example Sensor Co. Ltd.']!.ppm).toBeCloseTo(500000, 3);
      expect(by['示例精密五金有限公司']!.ppm).toBeCloseTo(4000, 3);
      expect(by['示例电子材料有限公司']!.lot_pass_rate).toBeCloseTo(0.5, 6);
      expect(by['示例包装制品有限公司']!.lot_pass_rate).toBeNull();
    });

    it('counts on-time and late lines by month for the delivery dashboard', async () => {
      const rows = await metrics(['receipt_month'], ['on_time_count', 'late_count']);
      expect(rows.find((r) => r.receipt_month === '2026-09')).toMatchObject({ on_time_count: 9, late_count: 6 });
    });

    // 模拟「脏」表格（docs/implementation/delivery-import.md §5）：逐行钉住平台的结果
    it('reports every bad row of a messy export and imports the rest', async () => {
      const result = await importDeliveries(sample('delivery-trial/srm_delivery_record.csv'));
      const outcome = result.results.map((r) => (r.ok ? r.action : r.code));
      expect(outcome, JSON.stringify(result.results)).toEqual([
        'invalid_date', // 1 需求日期 2026.10.08
        'invalid_date', // 2 日期 20261008
        'reference_not_found', // 3 供应商写简称
        'reference_not_found', // 4 物料号不存在
        'invalid_option', // 5 检验结论写 OK
        'required', // 6 不合格没有严重度
        'required', // 7 不合格没有不良数
        'rule_violation', // 8 不良数大于实收数
        'created', // 9 表格带了期间、准时两列：被忽略，按实到日期重算
        'UNIQUE_VIOLATION', // 10 同一张表里重复的行
        'required', // 11 没有实到日期
        'created', // 12 数量带千分位「1,200」
        'min_value', // 13 负数（退货行）
        'reference_not_found', // 14 工厂写简称「一厂」
        'required', // 15 没有收货单号
        'created', // 16 物料列写物料名称：按名称找到
        'created', // 17 检验结论带尾随空格
        'reference_not_found', // 18 物料号小写
      ]);
      const [ignored] = await stack.rows(DeliveryRecord.name, { erp_receipt_no: '5000090009' });
      expect([ignored!.period, ignored!.on_time]).toEqual(['2026-10', false]);
      const [thousands] = await stack.rows(DeliveryRecord.name, { erp_receipt_no: '5000090011' });
      expect(thousands!.received_quantity).toBe(1200);
    });
  });
});
