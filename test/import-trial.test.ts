import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierCertificate, SupplierContact } from '../src/core/objects';

// 存量导入试导（#10 出口条件）：data/samples/legacy-trial/ 是模拟的「脏」台账，覆盖重复行、格式错误的
// 信用代码、混合日期格式、选项别名、缺字段、同表两位主联系人等常见问题。这里逐行钉住平台给出的结果，
// 结论写在导入说明 §6。18.3.0 起同一文件里匹配键相同的行一律不写（objectstack#26133），所以先按原样导一次供应商
// 钉住报错，再按清洗清单 §6.2 第 5 条去掉重复行重导，联系人和证书在清洗后的供应商上导入。
describe('legacy import trial with a messy ledger', () => {
  let stack: VerifyStack;
  let importer: string;

  type Row = { row: number; action: string; code?: string; field?: string };
  type ImportResult = { created: number; errors: number; skipped: number; results: Row[] };
  type Described = { name: string; fields: Record<string, { label?: unknown }> };

  const sheet = (file: string) => readFileSync(new URL(`../data/samples/legacy-trial/${file}`, import.meta.url), 'utf8');
  // 清洗清单 §6.2 第 5 条：同一家只留一行。去掉的是表里的第 2、11 行数据（华东紧固带尾随空格的一行、境外重复行）
  const withoutRows = (csv: string, rows: number[]) =>
    csv
      .split('\n')
      .filter((_, i) => !rows.includes(i))
      .join('\n');
  const run = async (object: Described, csv: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(importer, 'POST', `/data/${object.name}/import`, {
      format: 'csv',
      csv,
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

  let rawDomestic: ImportResult;
  let rawOverseas: ImportResult;
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

    rawDomestic = await run(Supplier, sheet('srm_supplier.csv'), ['credit_code'], true);
    rawOverseas = await run(Supplier, sheet('srm_supplier.csv'), ['country', 'registration_no'], true);
    const cleaned = withoutRows(sheet('srm_supplier.csv'), [2, 11]);
    domestic = await run(Supplier, cleaned, ['credit_code'], true);
    overseas = await run(Supplier, cleaned, ['country', 'registration_no'], true);
    contacts = await run(SupplierContact, sheet('srm_supplier_contact.csv'), ['supplier', 'email']);
    certificates = await run(SupplierCertificate, sheet('srm_supplier_certificate.csv'), ['supplier', 'cert_type', 'cert_no']);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('reports supplier rows that need cleaning', () => {
    expect(outcome(rawDomestic)).toEqual([
      'DUPLICATE_MATCH_KEY', // 1、2 同一家写了两行（第二行名称带尾随空格）：18.3.0 起两行都不写（objectstack#26133）
      'DUPLICATE_MATCH_KEY',
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
    expect(outcome(rawOverseas).slice(9)).toEqual([
      'DUPLICATE_MATCH_KEY', // 10、11 境外重复行，同样两行都不写
      'DUPLICATE_MATCH_KEY',
      'BLANK_MATCH_KEY', // 12 境外缺注册号：两遍都被跳过
      'created', // 13
    ]);
  });

  it('imports the suppliers once the duplicate rows are removed', () => {
    // 清洗后的表少了两行：华东紧固（第 1 行）、Example Precision（第 9 行）建档，新材料（第 8 行）上一轮已建，这次更新
    expect(outcome(domestic)[0]).toBe('created');
    expect(outcome(domestic)[7]).toBe('updated');
    expect(outcome(overseas).slice(8)).toEqual(['created', 'BLANK_MATCH_KEY', 'updated']);
  });

  it('fails contacts and certificates of suppliers that did not import', () => {
    expect(contacts.results.filter((r) => r.code === 'reference_not_found'), JSON.stringify(contacts.results)).toHaveLength(6);
    expect(certificates.results.find((r) => r.row === 5)!.code).toBe('reference_not_found'); // 精工模具没导入
  });

  // ISO9001 从 18.1.0 起按选项值接受，它和上一行是同一张证书：18.3.0 起同一文件里匹配键相同的两行都不写（objectstack#26133）
  it('refuses a certificate listed twice in one sheet', async () => {
    expect([2, 3].map((n) => certificates.results.find((r) => r.row === n)!.code)).toEqual(['DUPLICATE_MATCH_KEY', 'DUPLICATE_MATCH_KEY']);
    const [supplier] = await stack.rows(Supplier.name, { credit_code: '91000000MA0TRIAL01' }, { as: importer });
    expect(await stack.rows(SupplierCertificate.name, { supplier: supplier!.id, cert_type: 'iso9001' }, { as: importer })).toEqual([]);
  });

  it('keeps a certificate with no expiry date as never expiring', async () => {
    expect(certificates.results.find((r) => r.row === 1)!.action).toBe('created'); // 有效期至「长期」
    const [supplier] = await stack.rows(Supplier.name, { credit_code: '91000000MA0TRIAL01' }, { as: importer });
    const [license] = await stack.rows(SupplierCertificate.name, { supplier: supplier!.id, cert_type: 'business_license' }, { as: importer });
    expect(license!.valid_to ?? null).toBeNull();
  });

  // 华东紧固：同表两位主联系人；新材料：同一人邮箱大小写不同写了两行（匹配区分大小写，是两个联系人）。
  // 18.3.0 起同一批里的第二位主联系人也被校验规则拦下（objectstack#25579），不再进「主联系人重复」视图
  it('refuses the second primary contact from the same sheet', async () => {
    expect([2, 9].map((n) => contacts.results.find((r) => r.row === n)!.code)).toEqual(['rule_violation', 'rule_violation']);
    expect(await stack.rows(Supplier.name, { primary_contact_count: { $gt: 1 } }, { as: importer })).toEqual([]);
  });
});
