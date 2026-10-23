import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierCertificate, SupplierContact } from '../src/core/objects';

// 存量导入试导（#10 出口条件）：data/samples/legacy-trial/ 是模拟的「脏」台账，覆盖重复行、格式错误的
// 信用代码、混合日期格式、选项别名、缺字段、同表两位主联系人等常见问题。这里逐行钉住平台给出的结果，
// 结论写在导入说明 §6。平台修复 objectstack#25476 / #25491 / #25493 后这里的预期会变，届时同步更新说明。
describe('legacy import trial with a messy ledger', () => {
  let stack: VerifyStack;
  let importer: string;

  type Row = { row: number; action: string; code?: string; field?: string };
  type ImportResult = { created: number; errors: number; skipped: number; results: Row[] };
  type Described = { name: string; fields: Record<string, { label?: unknown }> };

  const sheet = (file: string) => readFileSync(new URL(`../data/samples/legacy-trial/${file}`, import.meta.url), 'utf8');
  const run = async (object: Described, file: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(importer, 'POST', `/data/${object.name}/import`, {
      format: 'csv',
      csv: sheet(file),
      mapping: Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name])),
      writeMode: 'upsert',
      matchFields,
      skipBlankMatchKey,
      // 台账里「长期」等表示没有到期日
      nullValues: ['长期', '无', '/'],
    });
    const body = (await res.json()) as ImportResult & { data?: ImportResult };
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.data ?? body;
  };
  // 每行的结果：成功写 action，失败或跳过写 code
  const outcome = (result: ImportResult) => result.results.map((r) => (r.action === 'created' || r.action === 'updated' ? r.action : r.code));

  let domestic: ImportResult;
  let overseas: ImportResult;
  let contacts: ImportResult;
  let certificates: ImportResult;

  beforeAll(async () => {
    stack = await bootStack(config);
    importer = await stack.signUp('trial-importer@example.com');
    const context = await stack.contextFor(importer);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position: 'srm_admin', ...org }]);

    domestic = await run(Supplier, 'srm_supplier.csv', ['credit_code'], true);
    overseas = await run(Supplier, 'srm_supplier.csv', ['country', 'registration_no'], true);
    contacts = await run(SupplierContact, 'srm_supplier_contact.csv', ['supplier', 'email']);
    certificates = await run(SupplierCertificate, 'srm_supplier_certificate.csv', ['supplier', 'cert_type', 'cert_no']);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('reports supplier rows that need cleaning', () => {
    expect(outcome(domestic)).toEqual([
      'created', // 1
      'UNIQUE_VIOLATION', // 2 同一家重复一行（名称带尾随空格）
      'invalid_date', // 3 2011.07.01（小写信用代码要改完日期才报，每行只报第一个错误）
      'invalid_date', // 4 20090615
      'invalid_date', // 5 2018-02-30
      'invalid_option', // 6 中国大陆
      'BLANK_MATCH_KEY', // 7 缺信用代码：两遍都被跳过，不报错（objectstack#25476）
      'invalid_option', // 8 物流（应为物流商）
      'invalid_option', // 9 CN（应为中国）
      'BLANK_MATCH_KEY', // 10–13 境外行，第二遍处理
      'BLANK_MATCH_KEY',
      'BLANK_MATCH_KEY',
      'BLANK_MATCH_KEY',
    ]);
    expect(outcome(overseas).slice(9)).toEqual([
      'created', // 10
      'UNIQUE_VIOLATION', // 11 境外重复行
      'BLANK_MATCH_KEY', // 12 境外缺注册号：两遍都被跳过
      'created', // 13
    ]);
  });

  it('fails contacts and certificates of suppliers that did not import', () => {
    expect(contacts.results.filter((r) => r.code === 'reference_not_found')).toHaveLength(8);
    expect(certificates.results.find((r) => r.row === 3)!.code).toBe('invalid_option'); // ISO9001（应为 ISO 9001）
  });

  it('keeps a certificate with no expiry date as never expiring', async () => {
    expect(certificates.results.find((r) => r.row === 1)!.action).toBe('created'); // 有效期至「长期」
    const [supplier] = await stack.rows(Supplier.name, { credit_code: '91000000MA0TRIAL01' }, { as: importer });
    const [license] = await stack.rows(SupplierCertificate.name, { supplier: supplier!.id, cert_type: 'business_license' }, { as: importer });
    expect(license!.valid_to ?? null).toBeNull();
  });

  it('surfaces two primary contacts from the same sheet for review', async () => {
    const conflicts = await stack.rows(Supplier.name, { primary_contact_count: { $gt: 1 } }, { as: importer });
    expect(conflicts.map((s) => s.name)).toEqual(['示例华东紧固件有限公司']);
  });
});
