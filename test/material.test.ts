import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Material } from '../src/core/objects';

// 物料只读副本（02 §4.1，ADR-0008）：样例表格按 erp_material_no 重复导入结果不变；
// 采购员只能维护品类关联。
const sampleCsv = readFileSync(new URL('../data/samples/srm_material.csv', import.meta.url), 'utf8');
const importBody = { format: 'csv', csv: sampleCsv, writeMode: 'upsert', matchFields: ['erp_material_no'] };
const fields = ['erp_material_no', 'material_code', 'name', 'specification', 'uom', 'active'] as const;

describe('material import and maintenance', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (position: string) => {
    const token = await stack.signUp(`material-${position}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };
  const snapshot = (rows: Array<Record<string, unknown>>) =>
    rows
      .map((row) => Object.fromEntries(fields.map((f) => [f, row[f]])))
      .sort((a, b) => String(a.erp_material_no).localeCompare(String(b.erp_material_no)));
  const runImport = async (token: string) => {
    const res = await stack.apiAs(token, 'POST', `/data/${Material.name}/import`, importBody);
    expect(res.status).toBe(200);
    return res.json() as Promise<{ total: number; ok: number; errors: number; created: number; updated: number }>;
  };

  beforeAll(async () => {
    stack = await bootStack(config);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('imports the sample sheet twice with the same result', async () => {
    const admin = await person('srm_admin');
    const lines = sampleCsv.trim().split('\n').length - 1;

    const first = await runImport(admin);
    expect(first).toMatchObject({ total: lines, errors: 0, created: lines, updated: 0 });
    const afterFirst = snapshot(await stack.rows(Material.name, {}, { as: admin }));

    const second = await runImport(admin);
    expect(second).toMatchObject({ total: lines, errors: 0, created: 0 });
    const afterSecond = snapshot(await stack.rows(Material.name, {}, { as: admin }));

    expect(afterSecond).toHaveLength(lines);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.find((m) => m.erp_material_no === 'EX-300002')).toMatchObject({ active: false, uom: '盒' });
  });

  it('keeps a buyer-maintained category when the sheet is imported again', async () => {
    const admin = await person('srm_admin');
    const buyer = await person('srm_buyer');
    const [category] = await stack.rows('srm_category', { code: 'ELEC' }, { as: buyer });
    const [material] = await stack.rows(Material.name, { erp_material_no: 'EX-100001' }, { as: buyer });
    await stack.hooks.run(Material.name, 'update', { id: material!.id, category: category!.id }, { as: buyer });

    await runImport(admin);
    const [row] = await stack.rows(Material.name, { id: material!.id }, { as: admin });
    expect(row!.category).toBe(category!.id);
  });

  it('lets a buyer set the category but not change ERP-owned fields', async () => {
    const buyer = await person('srm_buyer');
    const [category] = await stack.rows('srm_category', { code: 'PACK' }, { as: buyer });
    const [material] = await stack.rows(Material.name, { erp_material_no: 'EX-200001' }, { as: buyer });

    await stack.hooks.run(Material.name, 'update', { id: material!.id, category: category!.id }, { as: buyer });
    for (const change of [{ name: '改名' }, { specification: '改规格' }, { active: false }]) {
      await expect(
        stack.hooks.run(Material.name, 'update', { id: material!.id, ...change }, { as: buyer }),
      ).rejects.toBeTruthy();
    }

    const [row] = await stack.rows(Material.name, { id: material!.id }, { as: buyer });
    expect(row).toMatchObject({ category: category!.id, name: material!.name, specification: material!.specification, active: true });
  });

  it('does not let a buyer create or delete materials', async () => {
    const buyer = await person('srm_buyer');
    await expect(
      stack.hooks.run(Material.name, 'insert', { erp_material_no: 'EX-999999', material_code: 'X', name: '采购员新建' }, { as: buyer }),
    ).rejects.toBeTruthy();
    const [material] = await stack.rows(Material.name, { erp_material_no: 'EX-300001' }, { as: buyer });
    await expect(stack.hooks.run(Material.name, 'delete', { id: material!.id }, { as: buyer })).rejects.toBeTruthy();
  });

  it('refuses a second material with the same ERP number', async () => {
    const admin = await person('srm_admin');
    await expect(
      stack.hooks.run(Material.name, 'insert', { erp_material_no: 'EX-100001', material_code: 'DUP', name: '重复' }, { as: admin }),
    ).rejects.toBeTruthy();
  });
});
