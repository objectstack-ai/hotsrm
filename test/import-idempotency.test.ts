import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { DeliveryRecord, Material, Supplier, SupplierCertificate, SupplierContact } from '../src/core/objects';

// 存量供应商导入（07 R6、docs/implementation/legacy-supplier-import.md）：样例三张表格用平台导入跑两遍，结果一致；
// 不合格行逐行报错不影响其他行；重复导入不回退流程写入的状态。
describe('legacy supplier import', () => {
  let stack: VerifyStack;
  let importer: string;
  let seq = 0;

  type ImportResult = { total: number; ok: number; errors: number; created: number; updated: number; skipped: number; results: Array<{ row: number; ok: boolean; action: string; field?: string; code?: string; error?: string }> };

  const sample = (file: string) => readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
  // 表头用字段的中文标签，与导入向导按标签对列一致
  const mappingFor = (object: { fields: Record<string, { label?: unknown }> }) =>
    Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name]));

  const run = async (object: { name: string; fields: Record<string, { label?: unknown }> }, csv: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(importer, 'POST', `/data/${object.name}/import`, {
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

  // 供应商分两遍：境内按信用代码，境外按国家 / 地区 + 注册号；每遍跳过另一类的行
  const importSuppliers = async (csv = sample('srm_supplier.csv')) => [
    await run(Supplier, csv, ['credit_code'], true),
    await run(Supplier, csv, ['country', 'registration_no'], true),
  ];
  const importContacts = (csv = sample('srm_supplier_contact.csv')) => run(SupplierContact, csv, ['supplier', 'email']);
  const importCertificates = (csv = sample('srm_supplier_certificate.csv')) => run(SupplierCertificate, csv, ['supplier', 'cert_type', 'cert_no']);
  const importAll = async () => ({
    suppliers: await importSuppliers(),
    contacts: await importContacts(),
    certificates: await importCertificates(),
  });

  const sweep = async () => {
    const res = await stack.flows.run('srm_certificate_expire_sweep', {}, { system: true });
    expect(res.success, JSON.stringify(res)).toBe(true);
  };
  const supplierByName = async (name: string) => (await stack.rows(Supplier.name, { name }, { as: importer }))[0]!;
  // 只比较导入写入和流程算出的业务字段，不比较时间戳
  const snapshot = async () => {
    const pick = (rows: Array<Record<string, unknown>>, keys: string[]) =>
      rows.map((row) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const legacy = await stack.rows(Supplier.name, { legacy_imported: true }, { as: importer });
    const ids = legacy.map((s) => s.id);
    return {
      suppliers: pick(legacy, ['id', 'name', 'country', 'credit_code', 'registration_no', 'status', 'legacy_reviewed', 'qualification_alert']),
      contacts: pick(await stack.rows(SupplierContact.name, { supplier: { $in: ids } }, { as: importer }), ['id', 'supplier', 'email', 'is_primary']),
      certificates: pick(await stack.rows(SupplierCertificate.name, { supplier: { $in: ids } }, { as: importer }), ['id', 'supplier', 'cert_type', 'cert_no', 'valid_to', 'status', 'is_mandatory']),
    };
  };

  const person = async (position: string) => {
    const token = await stack.signUp(`${position}-import-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };

  beforeAll(async () => {
    stack = await bootStack(config);
    importer = await person('srm_admin');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('imports the three sample sheets without errors', async () => {
    const { suppliers, contacts, certificates } = await importAll();
    expect(suppliers.map((r) => [r.created, r.errors])).toEqual([[4, 0], [2, 0]]);
    expect([contacts.created, contacts.errors]).toEqual([7, 0]);
    expect([certificates.created, certificates.errors]).toEqual([7, 0]);

    const domestic = await supplierByName('示例精密五金有限公司');
    expect(domestic.status).toBe('qualified');
    expect(domestic.legacy_imported).toBe(true);
    expect(domestic.legacy_reviewed).toBe(false);
    const overseas = await supplierByName('Example Sensor Co. Ltd.');
    expect([overseas.country, overseas.status]).toEqual(['jp', 'qualified']);
  });

  it('flags the expired mandatory certificate after the next sweep', async () => {
    await sweep();
    const supplier = await supplierByName('示例电子材料有限公司');
    const [expired] = await stack.rows(SupplierCertificate.name, { supplier: supplier.id, cert_no: 'EX-QMS-0002' }, { as: importer });
    expect(expired!.status).toBe('expired');
    expect((await supplierByName('示例电子材料有限公司')).qualification_alert).toBe(true);
    // 非必备证书过期不触发资质异常
    expect((await supplierByName('示例物流服务有限公司')).qualification_alert).toBe(false);
  });

  it('gives the same result when the sheets are imported again', async () => {
    const before = await snapshot();
    const { suppliers, contacts, certificates } = await importAll();
    expect(suppliers.map((r) => [r.created, r.updated, r.errors])).toEqual([[0, 4, 0], [0, 2, 0]]);
    expect([contacts.created, contacts.updated, contacts.errors]).toEqual([0, 7, 0]);
    expect([certificates.created, certificates.updated, certificates.errors]).toEqual([0, 7, 0]);
    expect(await snapshot()).toEqual(before);
  });

  it('does not roll back states written after the first import', async () => {
    const supplier = await supplierByName('示例工业品商贸有限公司');
    await stack.hooks.run(Supplier.name, 'update', { id: supplier.id, status: 'frozen' }, { system: true });
    const manager = await person('srm_category_manager');
    await stack.actions.run(Supplier.name, 'srm_confirm_legacy_review', { as: manager, recordId: String(supplier.id) });

    await importAll();
    const after = await supplierByName('示例工业品商贸有限公司');
    expect([after.status, after.legacy_imported, after.legacy_reviewed], JSON.stringify(after)).toEqual(['frozen', true, true]);
    // 资质扫描写入的证书状态也不被导入改回
    const alerted = await supplierByName('示例电子材料有限公司');
    expect(alerted.qualification_alert).toBe(true);
  });

  it('does not mark a supplier registered through admission as legacy', async () => {
    const credit = '91000000MA0LEGAC09';
    await stack.hooks.run(Supplier.name, 'insert', { name: '示例准入在途有限公司', credit_code: credit }, { system: true });
    const [result] = await importSuppliers(`公司全称,国家 / 地区,统一社会信用代码,存量导入\n示例准入在途有限公司,中国,${credit},是\n`);
    expect([result!.updated, result!.errors], JSON.stringify(result)).toEqual([1, 0]);
    const row = await supplierByName('示例准入在途有限公司');
    expect([row.status, row.legacy_imported]).toEqual(['potential', false]);
  });

  it('reports bad rows one by one and imports the rest', async () => {
    const [domestic] = await importSuppliers(
      [
        '公司全称,国家 / 地区,统一社会信用代码,存量导入',
        '示例格式错误有限公司,中国,91-BAD,是',
        ',中国,91000000MA0LEGAC11,是',
        '示例合规补录有限公司,中国,91000000MA0LEGAC12,是',
      ].join('\n'),
    );
    expect(domestic!.results.map((r) => r.ok), JSON.stringify(domestic)).toEqual([false, false, true]);
    expect(domestic!.results[0]!.error).toMatch(/Credit Code|统一社会信用代码/);

    const contacts = await importContacts(
      [
        '供应商,姓名,邮箱,主联系人',
        '示例精密五金有限公司,示例第二主联系人,second@wujin.example.com,是',
        '示例不存在有限公司,示例联系人,nobody@example.com,否',
        '示例合规补录有限公司,示例联系人六,a@bulu.example.com,是',
      ].join('\n'),
    );
    expect(contacts.results.map((r) => r.ok), JSON.stringify(contacts)).toEqual([false, false, true]);
    expect(contacts.results[0]!.error).toMatch(/primary contact|主联系人/i);

    const certificates = await importCertificates(
      [
        '供应商,资质类型,证书编号,生效日期,有效期至,存量导入',
        '示例合规补录有限公司,ISO 9001,EX-QMS-0011,2025-01-01,2024-01-01,是',
        '示例合规补录有限公司,营业执照,,2025-01-01,2045-01-01,是',
        '示例合规补录有限公司,营业执照,91000000MA0LEGAC12,2025-01-01,2045-01-01,是',
      ].join('\n'),
    );
    expect(certificates.results.map((r) => r.ok), JSON.stringify(certificates)).toEqual([false, false, true]);
    expect(certificates.results[0]!.error).toMatch(/Valid To|有效期至/i);
  });

  // 同一批里的第二位主联系人校验规则看不到（objectstack#25477），由「主联系人重复」视图兜底
  it('surfaces two primary contacts imported in the same sheet', async () => {
    await importSuppliers('公司全称,国家 / 地区,统一社会信用代码,存量导入\n示例双主联系人有限公司,中国,91000000MA0LEGAC31,是\n');
    const contacts = await importContacts(
      [
        '供应商,姓名,邮箱,主联系人',
        '示例双主联系人有限公司,示例甲,a@shuangzhu.example.com,是',
        '示例双主联系人有限公司,示例乙,b@shuangzhu.example.com,是',
      ].join('\n'),
    );
    expect(contacts.errors).toBe(0);
    const supplier = await supplierByName('示例双主联系人有限公司');
    expect(supplier.primary_contact_count).toBe(2);
    const conflicts = await stack.rows(Supplier.name, { primary_contact_count: { $gt: 1 } }, { as: importer });
    expect(conflicts.map((s) => s.name)).toEqual(['示例双主联系人有限公司']);
  });

  it('keeps the legacy flag out of a category manager\'s hands', async () => {
    const manager = await person('srm_category_manager');
    await expect(
      stack.hooks.run(Supplier.name, 'insert', { name: '示例绕过准入有限公司', credit_code: '91000000MA0LEGAC21', legacy_imported: true }, { as: manager }),
    ).rejects.toBeTruthy();
    await expect(
      stack.hooks.run(Supplier.name, 'insert', { name: '示例直接合格有限公司', credit_code: '91000000MA0LEGAC22', status: 'qualified' }, { system: true }),
    ).rejects.toBeTruthy();
  });

  it('lists imported suppliers awaiting review until they are confirmed', async () => {
    const view = (await stack.metadata.items<{ name?: string; listViews?: Record<string, { filter: unknown }> }>('view'))
      .find((v) => v.listViews?.legacy_review)!;
    expect(view.listViews!.legacy_review!.filter).toEqual([
      { field: 'legacy_imported', operator: 'equals', value: true },
      { field: 'legacy_reviewed', operator: 'equals', value: false },
    ]);
    const pending = await stack.rows(Supplier.name, { legacy_imported: true, legacy_reviewed: false }, { as: importer });
    expect(pending.map((s) => s.name)).not.toContain('示例工业品商贸有限公司');
    expect(pending.map((s) => s.name)).toContain('示例精密五金有限公司');
  });
});

// 交付记录月度导入（v0.4 Q1，03 §8、docs/implementation/delivery-import.md）：同一张月度表格导两遍，第二遍只更新、
// 不新增，记录与算出的准时、期间不变。
describe('delivery record import', () => {
  let stack: VerifyStack;
  let seq = 0;

  type ImportResult = { created: number; updated: number; errors: number };
  type Described = { name: string; fields: Record<string, { label?: unknown }> };

  const sample = (file: string) => readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
  const person = async (position: string) => {
    const token = await stack.signUp(`${position}-delivery-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };
  const run = async (token: string, object: Described, file: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(token, 'POST', `/data/${object.name}/import`, {
      format: 'csv',
      csv: sample(file),
      mapping: Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name])),
      writeMode: 'upsert',
      matchFields,
      skipBlankMatchKey,
    });
    const body = (await res.json()) as ImportResult & { data?: ImportResult };
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.data ?? body;
  };
  let sqe: string;
  const importDeliveries = () => run(sqe, DeliveryRecord, 'srm_delivery_record.csv', ['erp_receipt_no', 'erp_order_no', 'erp_line_no']);
  const snapshot = async () =>
    (await stack.rows(DeliveryRecord.name, {}, { as: sqe }))
      .map((r) =>
        ['id', 'erp_receipt_no', 'erp_order_no', 'erp_line_no', 'supplier', 'material', 'plant', 'receipt_date', 'received_quantity', 'inspection_result', 'severity', 'defect_quantity', 'on_time', 'period', 'received_quantity_mn']
          .map((k) => r[k] ?? null),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  beforeAll(async () => {
    stack = await bootStack(config);
    const admin = await person('srm_admin');
    sqe = await person('srm_sqe');
    await run(admin, Material, 'srm_material.csv', ['erp_material_no']);
    await run(admin, Supplier, 'srm_supplier.csv', ['credit_code'], true);
    await run(admin, Supplier, 'srm_supplier.csv', ['country', 'registration_no'], true);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('gives the same result when the monthly sheet is imported twice', async () => {
    const first = await importDeliveries();
    expect([first.created, first.updated, first.errors], JSON.stringify(first)).toEqual([15, 0, 0]);
    const before = await snapshot();
    expect(before).toHaveLength(15);

    const second = await importDeliveries();
    expect([second.created, second.updated, second.errors], JSON.stringify(second)).toEqual([0, 15, 0]);
    expect(await snapshot()).toEqual(before);
  });
});
