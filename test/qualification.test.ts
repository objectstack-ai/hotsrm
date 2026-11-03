import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import { uploadedFile } from './support/files';
import config from '../objectstack.config';
import { Category, Supplier, SupplierCategory, SupplierCertificate } from '../src/core/objects';

// P10 资质监控（03 §11）：每日扫描对齐证书状态，必备证书过期时供应商标记资质异常，延期后解除。
describe('qualification monitoring', () => {
  let stack: VerifyStack;
  let admin: string;
  let seq = 0;

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const read = async (object: string, id: string) => (await stack.rows(object, { id }, { as: admin }))[0]!;
  const sweep = async () => {
    const run = await stack.flows.run('srm_certificate_expire_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };

  const newSupplier = async () =>
    (await stack.hooks.run(
      Supplier.name,
      'insert',
      { name: `资质测试供应商 ${++seq}`, credit_code: `91000000MA0QUA${String(seq).padStart(4, '0')}` },
      { as: admin },
    )).id as string;
  const newCertificate = async (supplier: string, validTo: string, isMandatory: boolean, certType = 'iso9001') => {
    const file = await uploadedFile(stack, admin, 'cert');
    const cert = await stack.hooks.run(
      SupplierCertificate.name,
      'insert',
      { supplier, cert_type: certType, valid_from: day(-400), valid_to: validTo, is_mandatory: isMandatory, attachment: file },
      { as: admin },
    );
    return cert.id as string;
  };

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('expires a mandatory certificate and raises the qualification alert', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(-1), true);
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).status).toBe('expired');
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
  });

  it('clears the alert once the expired certificate is renewed', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(-1), true);
    await sweep();
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: cert, valid_to: day(365) }, { as: admin });
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).status).toBe('valid');
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(false);
  });

  it('marks a certificate due within 30 days as expiring without an alert', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(10), true);
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).status).toBe('expiring');
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(false);
  });

  it('does not raise the alert for an optional certificate', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(-1), false);
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).status).toBe('expired');
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(false);
  });

  // 资质异常按资质类型判断（03 §11）：另一种必备资质还过期着，续了这一种也不解除
  it('keeps the alert while a mandatory certificate of another type is still expired', async () => {
    const supplier = await newSupplier();
    const first = await newCertificate(supplier, day(-1), true);
    await newCertificate(supplier, day(-2), true, 'business_license');
    await sweep();
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: first, valid_to: day(365) }, { as: admin });
    await sweep();
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
  });

  // 同类型补了一张新证书（内部录入即核验）就顶得住过期的旧证书，不必删除旧证书
  it('clears the alert once a verified certificate of the same type replaces the expired one', async () => {
    const supplier = await newSupplier();
    await newCertificate(supplier, day(-1), true);
    await sweep();
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
    const renewed = await newCertificate(supplier, day(365), true);
    expect(await read(SupplierCertificate.name, renewed)).toMatchObject({ verified: true });
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(false);
  });

  it('changes nothing on a second run', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(-1), true);
    await sweep();
    const before = await read(SupplierCertificate.name, cert);
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).updated_at).toBe(before.updated_at);
  });

  // 必备资质由 flow 按品类标记（02 §4.1、03 §11）：示例品类「电子元器件」的必备资质是营业执照与 ISO 9001
  const grant = async (supplier: string, code: string) => {
    const [category] = await stack.rows(Category.name, { code }, { as: admin });
    await stack.hooks.run(SupplierCategory.name, 'insert', { supplier, category: category!.id, status: 'qualified' }, { as: admin });
  };

  it('marks certificates mandatory once the supplier is granted a category requiring them', async () => {
    const supplier = await newSupplier();
    const iso = await newCertificate(supplier, day(-1), false);
    const env = await newCertificate(supplier, day(-1), false, 'iso14001');
    await sweep();
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(false);
    await grant(supplier, 'ELEC');
    expect((await read(SupplierCertificate.name, iso)).is_mandatory).toBe(true);
    expect((await read(SupplierCertificate.name, env)).is_mandatory).toBe(false);
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
  });

  it('marks a new certificate mandatory when its type is required by a granted category', async () => {
    const supplier = await newSupplier();
    await grant(supplier, 'ELEC');
    const iso = await newCertificate(supplier, day(365), false);
    const env = await newCertificate(supplier, day(365), false, 'iso14001');
    expect((await read(SupplierCertificate.name, iso)).is_mandatory).toBe(true);
    expect((await read(SupplierCertificate.name, env)).is_mandatory).toBe(false);
    // 过期后照常标记资质异常
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: iso, valid_to: day(-1) }, { as: admin });
    await sweep();
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
  });

  it('keeps a manual mandatory flag when no granted category requires the type', async () => {
    const supplier = await newSupplier();
    await grant(supplier, 'PACK');
    const iso = await newCertificate(supplier, day(365), true);
    expect((await read(SupplierCertificate.name, iso)).is_mandatory).toBe(true);
  });
});
