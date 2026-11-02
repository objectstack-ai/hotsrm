import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierCertificate, SupplierContact } from '../src/core/objects';

// 存量导入试导（#10 出口条件）：data/samples/legacy-trial/ 是模拟的「脏」台账，覆盖重复行、格式错误的
// 信用代码、混合日期格式、选项别名、缺字段、同表两位主联系人等常见问题。这里逐行钉住平台给出的结果，
// 结论写在导入说明 §6。平台修复 objectstack#25476 / #25491 / #25493 / #26133 后这里的预期会变，届时同步更新说明。
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
      'rule_violation', // 3 信用代码小写（日期 2011.07.01 从 18.1.0 起能识别）
      'max_length', // 4 信用代码带连字符（日期 20090615 能识别）
      'invalid_date', // 5 2018-02-30
      'invalid_option', // 6 中国大陆
      'BLANK_MATCH_KEY', // 7 缺信用代码：两遍都被跳过，不报错（objectstack#25476）
      'invalid_option', // 8 物流（应为物流商）
      'created', // 9 国家写 CN、存量导入写 Y：18.1.0 起按选项值、不分大小写接受
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
    expect(contacts.results.filter((r) => r.code === 'reference_not_found')).toHaveLength(6);
    expect(certificates.results.find((r) => r.row === 5)!.code).toBe('reference_not_found'); // 精工模具没导入
  });

  // ISO9001 从 18.1.0 起按选项值接受；它和上一行是同一张证书，同一文件里两行匹配键相同却建成两条（objectstack#26133）
  it('writes a certificate listed twice in one sheet twice', async () => {
    expect([2, 3].map((n) => certificates.results.find((r) => r.row === n)!.action)).toEqual(['created', 'created']);
    const [supplier] = await stack.rows(Supplier.name, { credit_code: '91000000MA0TRIAL01' }, { as: importer });
    const iso = await stack.rows(SupplierCertificate.name, { supplier: supplier!.id, cert_type: 'iso9001' }, { as: importer });
    expect(iso.map((c) => c.cert_no)).toEqual(['EX-Q-1001', 'EX-Q-1001']);
  });

  it('keeps a certificate with no expiry date as never expiring', async () => {
    expect(certificates.results.find((r) => r.row === 1)!.action).toBe('created'); // 有效期至「长期」
    const [supplier] = await stack.rows(Supplier.name, { credit_code: '91000000MA0TRIAL01' }, { as: importer });
    const [license] = await stack.rows(SupplierCertificate.name, { supplier: supplier!.id, cert_type: 'business_license' }, { as: importer });
    expect(license!.valid_to ?? null).toBeNull();
  });

  // 华东紧固：同表两位主联系人；新材料：同一人邮箱大小写不同写了两行，建成两个主联系人（匹配区分大小写）
  it('surfaces two primary contacts from the same sheet for review', async () => {
    const conflicts = await stack.rows(Supplier.name, { primary_contact_count: { $gt: 1 } }, { as: importer });
    expect(conflicts.map((s) => s.name).sort()).toEqual(['示例华东紧固件有限公司', '示例新材料科技有限公司'].sort());
  });
});
