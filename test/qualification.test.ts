import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierCertificate } from '../src/core/objects';

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
  const newCertificate = async (supplier: string, validTo: string, isMandatory: boolean) => {
    const name = `cert-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [
      { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' },
    ]);
    const cert = await stack.hooks.run(
      SupplierCertificate.name,
      'insert',
      { supplier, cert_type: 'iso9001', valid_from: day(-400), valid_to: validTo, is_mandatory: isMandatory, attachment: String(file!.id) },
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

  it('keeps the alert while another mandatory certificate is still expired', async () => {
    const supplier = await newSupplier();
    const first = await newCertificate(supplier, day(-1), true);
    await newCertificate(supplier, day(-2), true);
    await sweep();
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: first, valid_to: day(365) }, { as: admin });
    await sweep();
    expect((await read(Supplier.name, supplier)).qualification_alert).toBe(true);
  });

  it('changes nothing on a second run', async () => {
    const supplier = await newSupplier();
    const cert = await newCertificate(supplier, day(-1), true);
    await sweep();
    const before = await read(SupplierCertificate.name, cert);
    await sweep();
    expect((await read(SupplierCertificate.name, cert)).updated_at).toBe(before.updated_at);
  });
});
