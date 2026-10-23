import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, Supplier, SupplierCategory, SupplierCertificate, SupplierContact } from '../src/core/objects';

// 供应商主数据的规则：查重（BR-01）、状态机（02 §5.1）、证书有效期、汇总字段。
describe('supplier master data', () => {
  let stack: VerifyStack;
  let admin: string;
  let seq = 0;

  // 每个用例用自己的信用代码，互不干扰
  const creditCode = () => `91000000MA0TEST${String(++seq).padStart(3, '0')}`;
  const newSupplier = (extra: Record<string, unknown> = {}) =>
    stack.hooks.run(Supplier.name, 'insert', { name: `测试供应商 ${++seq}`, credit_code: creditCode(), ...extra }, { as: admin });

  // 证书扫描件必填；一条文件记录只能被一个字段引用，所以每张证书各建一条
  const newScan = async () => {
    const name = `scan-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [
      { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' },
    ]);
    return String(file?.id);
  };

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('starts a new supplier as potential with a supplier number', async () => {
    const row = await newSupplier();
    expect(row.status).toBe('potential');
    expect(row.qualification_alert).toBe(false);
    expect(row.supplier_no).toMatch(/^SUP\d{7}$/);
  });

  it('refuses a duplicate credit code', async () => {
    const code = creditCode();
    await newSupplier({ credit_code: code });
    await expect(newSupplier({ credit_code: code })).rejects.toBeTruthy();
  });

  it('refuses a malformed credit code', async () => {
    await expect(newSupplier({ credit_code: 'abc123' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('requires a registration number for an overseas supplier, not a credit code', async () => {
    await expect(newSupplier({ country: 'de', credit_code: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const row = await newSupplier({ country: 'de', credit_code: null, registration_no: `DE${seq}` });
    expect(row.country).toBe('de');
  });

  it('refuses an overseas duplicate by country and registration number', async () => {
    await newSupplier({ country: 'jp', credit_code: null, registration_no: 'JP-0001' });
    await expect(newSupplier({ country: 'jp', credit_code: null, registration_no: 'JP-0001' })).rejects.toBeTruthy();
  });

  it('follows the status state machine', async () => {
    const row = await newSupplier();
    await expect(
      stack.hooks.run(Supplier.name, 'update', { id: row.id, status: 'qualified' }, { as: admin }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const qualifying = await stack.hooks.run(Supplier.name, 'update', { id: row.id, status: 'qualifying' }, { as: admin });
    expect(qualifying.status).toBe('qualifying');
  });

  it('refuses a certificate that expires before it starts', async () => {
    const supplier = await newSupplier();
    await expect(
      stack.hooks.run(
        SupplierCertificate.name,
        'insert',
        { supplier: supplier.id, cert_type: 'iso9001', valid_from: '2026-06-01', valid_to: '2026-01-01', attachment: await newScan() },
        { as: admin },
      ),
    ).rejects.toThrow(/Valid To cannot be earlier/);
  });

  it('counts contacts and expired certificates on the supplier', async () => {
    const supplier = await newSupplier();
    await stack.hooks.run(SupplierContact.name, 'insert', { supplier: supplier.id, name: '张三', email: 'zhang@example.com' }, { as: admin });
    for (const status of ['valid', 'expired']) {
      await stack.hooks.run(
        SupplierCertificate.name,
        'insert',
        { supplier: supplier.id, cert_type: 'iso9001', status, attachment: await newScan() },
        { as: admin },
      );
    }
    const [row] = await stack.rows(Supplier.name, { id: supplier.id }, { as: admin });
    expect(row).toMatchObject({ contact_count: 1, expired_certificate_count: 1 });
  });

  it('allows one qualification per supplier and category', async () => {
    const supplier = await newSupplier();
    const category = await stack.hooks.run(Category.name, 'insert', { code: `T${seq}`, name: '测试品类' }, { as: admin });
    const first = await stack.hooks.run(SupplierCategory.name, 'insert', { supplier: supplier.id, category: category.id }, { as: admin });
    expect(first.status).toBe('trial');
    await expect(
      stack.hooks.run(SupplierCategory.name, 'insert', { supplier: supplier.id, category: category.id }, { as: admin }),
    ).rejects.toBeTruthy();
  });
});
