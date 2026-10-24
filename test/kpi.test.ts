import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Kpi } from '../src/core/objects';
import { KpiViews } from '../src/core/views';
import { SrmSeedData } from '../src/core/data';

// 绩效指标库（02 §4.7，FR-701）：示例库启用指标权重合计 100% 且与 params/core.yaml 的 perf_kpi_weights 一致；
// 采购总监维护、不能删除，删除只给系统管理员，其余内部岗位只读。
type KpiRow = { code: string; weight: number; active?: boolean };
const seedKpis = SrmSeedData.find((seed) => seed.object === Kpi.name)!.records as KpiRow[];
const isActive = (row: { active?: unknown }) => row.active !== false;
const total = (rows: Array<Record<string, unknown>>) => Math.round(rows.reduce((sum, row) => sum + Number(row.weight), 0) * 10000) / 10000;

// 参数示例值是单行键值表：example: { LOT_PASS: 20, PPM: 10, … }
const paramWeights = () => {
  const yaml = readFileSync(new URL('../params/core.yaml', import.meta.url), 'utf8');
  const block = yaml.split(/\n(?=\S)/).find((b) => b.startsWith('perf_kpi_weights:'))!;
  const example = /example:\s*\{([^}]*)\}/.exec(block)![1]!;
  return Object.fromEntries(example.split(',').map((pair) => {
    const [code, value] = pair.split(':').map((s) => s.trim());
    return [code!, Number(value) / 100];
  }));
};

describe('KPI library', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (position: string) => {
    const token = await stack.signUp(`kpi-${position}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };
  const manualKpi = (extra: Record<string, unknown> = {}) => ({
    code: `T_${++seq}`,
    name: `测试指标 ${seq}`,
    dimension: 'service',
    method: 'manual',
    weight: 0.05,
    active: false,
    ...extra,
  });

  beforeAll(async () => {
    stack = await bootStack(config);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('ships a sample library whose active weights add up to 100% and match the parameter', () => {
    expect(total(seedKpis.filter(isActive))).toBe(1);
    expect(Object.fromEntries(seedKpis.filter(isActive).map((row) => [row.code, row.weight]))).toEqual(paramWeights());
    // 订单响应及时率要 ERP 订单确认数据，集成前不启用
    expect(seedKpis.find((row) => row.code === 'ACK_ON_TIME')).toMatchObject({ active: false });
  });

  it('loads the sample library with active weights adding up to 100%', async () => {
    const director = await person('srm_procurement_director');
    const rows = await stack.rows(Kpi.name, {}, { as: director });
    expect(rows.map((row) => row.code).sort()).toEqual(seedKpis.map((row) => row.code).sort());
    expect(total(rows.filter((row) => row.active === true))).toBe(1);
    expect(new Set(rows.map((row) => row.dimension))).toEqual(new Set(['quality', 'cost', 'delivery', 'service', 'hse']));
  });

  it('checks the total weight in the active KPI view', () => {
    const view = KpiViews.listViews!.active!;
    expect(view.filter).toEqual([{ field: 'active', operator: 'equals', value: true }]);
    expect(view.columns.find((column) => typeof column === 'object' && column.field === 'weight')).toMatchObject({ summary: 'sum' });
  });

  it('lets the procurement director maintain KPIs, including seeded ones, but not delete them', async () => {
    const director = await person('srm_procurement_director');
    const created = await stack.hooks.run(Kpi.name, 'insert', manualKpi(), { as: director });
    expect(created).toBeTruthy();

    const [price] = await stack.rows(Kpi.name, { code: 'PRICE' }, { as: director });
    await stack.hooks.run(Kpi.name, 'update', { id: price!.id, scoring_rule: '示例：采购总监调整后的评分规则' }, { as: director });
    const [after] = await stack.rows(Kpi.name, { id: price!.id }, { as: director });
    expect(after!.scoring_rule).toBe('示例：采购总监调整后的评分规则');

    await expect(stack.hooks.run(Kpi.name, 'delete', { id: price!.id }, { as: director })).rejects.toBeTruthy();
  });

  it('lets the SRM admin delete a KPI someone else created', async () => {
    const director = await person('srm_procurement_director');
    const admin = await person('srm_admin');
    const doc = manualKpi();
    await stack.hooks.run(Kpi.name, 'insert', doc, { as: director });
    const [row] = await stack.rows(Kpi.name, { code: doc.code }, { as: admin });
    await stack.hooks.run(Kpi.name, 'delete', { id: row!.id }, { as: admin });
    expect(await stack.rows(Kpi.name, { code: doc.code }, { as: admin })).toEqual([]);
  });

  it('keeps the library read-only for other internal positions', async () => {
    for (const position of ['srm_general_manager', 'srm_category_manager', 'srm_buyer', 'srm_sqe']) {
      const token = await person(position);
      const [otd] = await stack.rows(Kpi.name, { code: 'OTD' }, { as: token });
      expect(otd).toBeTruthy();
      await expect(stack.hooks.run(Kpi.name, 'update', { id: otd!.id, weight: 0.5 }, { as: token })).rejects.toBeTruthy();
      await expect(stack.hooks.run(Kpi.name, 'insert', manualKpi(), { as: token })).rejects.toBeTruthy();
    }
  });

  it('requires the metric and thresholds of an automatic KPI', async () => {
    const director = await person('srm_procurement_director');
    await expect(
      stack.hooks.run(Kpi.name, 'insert', manualKpi({ method: 'auto', dimension: 'delivery' }), { as: director }),
    ).rejects.toBeTruthy();
    await expect(
      stack.hooks.run(Kpi.name, 'insert', manualKpi({ method: 'auto', dimension: 'delivery', auto_metric: 'otd_rate', full_score_value: 95, zero_score_value: 95 }), { as: director }),
    ).rejects.toBeTruthy();
    const ok = await stack.hooks.run(
      Kpi.name,
      'insert',
      manualKpi({ method: 'auto', dimension: 'quality', auto_metric: 'ppm', full_score_value: 50, zero_score_value: 2000 }),
      { as: director },
    );
    expect(ok).toBeTruthy();
  });

  it('refuses an automatic metric on a manual KPI', async () => {
    const director = await person('srm_procurement_director');
    await expect(stack.hooks.run(Kpi.name, 'insert', manualKpi({ auto_metric: 'otd_rate' }), { as: director })).rejects.toBeTruthy();
  });

  it('refuses a zero weight on an active KPI but allows it on an inactive one', async () => {
    const director = await person('srm_procurement_director');
    await expect(stack.hooks.run(Kpi.name, 'insert', manualKpi({ weight: 0, active: true }), { as: director })).rejects.toBeTruthy();
    expect(await stack.hooks.run(Kpi.name, 'insert', manualKpi({ weight: 0 }), { as: director })).toBeTruthy();
  });

  it('refuses a second KPI with the same code', async () => {
    const director = await person('srm_procurement_director');
    await expect(stack.hooks.run(Kpi.name, 'insert', manualKpi({ code: 'OTD' }), { as: director })).rejects.toBeTruthy();
  });
});
