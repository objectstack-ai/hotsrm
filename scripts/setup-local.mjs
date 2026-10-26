// 本地演示环境初始化：每个岗位建一个测试账号、给演示品类指派负责人、导入 data/samples 样例数据。
// 只用于本地 `pnpm dev` 的开发库，不要对正式环境运行。用法见 docs/implementation/local-demo.md：
//   HOTSRM_DEMO_PASSWORD=<自定的测试密码> node scripts/setup-local.mjs
// 可重复运行：账号已存在则跳过，导入按匹配字段 upsert，不会重复建记录。
import { readFileSync } from 'node:fs';

const BASE = process.env.HOTSRM_URL ?? 'http://localhost:3000';
// 平台 `objectstack dev` 在空库上种的开发管理员（启动日志里会打印）；改过的话用环境变量覆盖
const ADMIN_EMAIL = process.env.OS_DEV_ADMIN_EMAIL ?? 'admin@objectos.ai';
const ADMIN_PASSWORD = process.env.OS_DEV_ADMIN_PASSWORD ?? 'admin123';
// 测试账号的密码由运行的人自己定，不写进仓库（AGENTS.md 红线 6）
const PASSWORD = process.env.HOTSRM_DEMO_PASSWORD;
if (!PASSWORD || PASSWORD.length < 8) {
  console.error('请用环境变量 HOTSRM_DEMO_PASSWORD 给测试账号设一个至少 8 位的密码，例如：\n  HOTSRM_DEMO_PASSWORD=<自定密码> node scripts/setup-local.mjs');
  process.exit(1);
}
const sample = (file) => readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8');
const USERS = [
  ['director', 'srm_procurement_director', '采购总监'],
  ['director2', 'srm_procurement_director', '采购总监二'],
  ['cm', 'srm_category_manager', '品类经理'],
  ['buyer', 'srm_buyer', '采购员'],
  ['buyerlead', 'srm_buyer_lead', '采购主管'],
  ['sqe', 'srm_sqe', 'SQE'],
  ['qm', 'srm_quality_manager', '质量经理'],
  ['iqc', 'srm_iqc_inspector', 'IQC 检验员'],
  ['ap', 'srm_ap_accountant', '应付会计'],
  ['legal', 'srm_legal_counsel', '法务'],
  ['evaluator', 'srm_evaluator', '评分人'],
  ['gm', 'srm_general_manager', '总经理'],
  ['compliance', 'srm_procurement_compliance', '内控 / 监标'],
  ['srmadmin', 'srm_admin', 'SRM 系统管理员'],
];

const api = async (token, method, path, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what} 失败 (${r.status}): ${JSON.stringify(r.json).slice(0, 500)}`);
  return r.json;
};
const signIn = async (email, password) =>
  must(await api(null, 'POST', '/auth/sign-in/email', { email, password }), `登录 ${email}`).token;
const rows = (j) => j.records ?? j.data?.records ?? j.data ?? [];

const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
const session = must(await api(admin, 'GET', '/auth/get-session'), '读取会话');
const org = session.session.activeOrganizationId;

// 1. 账号与岗位
const ids = {};
for (const [key, position, name] of USERS) {
  const email = `${key}@hotsrm.local`;
  const created = await api(admin, 'POST', '/auth/admin/create-user', { email, password: PASSWORD, name, mustChangePassword: false });
  if (created.status >= 300 && !JSON.stringify(created.json).includes('ALREADY_EXISTS')) must(created, `新建账号 ${email}`);
  const [user] = rows(must(await api(admin, 'GET', `/data/sys_user?email=${encodeURIComponent(email)}`), `查找 ${email}`));
  ids[key] = user.id;
  const has = rows(must(await api(admin, 'GET', `/data/sys_user_position?user_id=${user.id}&position=${position}`), '查岗位'));
  if (!has.length) must(await api(admin, 'POST', '/data/sys_user_position', { user_id: user.id, position, organization_id: org }), `指派岗位 ${position}`);
  console.log(`✓ ${email.padEnd(26)} ${name}`);
}
const tokens = {};
for (const key of ['srmadmin', 'cm', 'sqe']) tokens[key] = await signIn(`${key}@hotsrm.local`, PASSWORD);

// 2. 演示品类指派品类经理 / SQE / 采购员 / 评分人（审批、整改单按品类找人）
for (const cat of rows(must(await api(admin, 'GET', '/data/srm_category'), '读品类'))) {
  must(await api(admin, 'PATCH', `/data/srm_category/${cat.id}`, { category_manager: ids.cm, sqe: ids.sqe, buyer: ids.buyer, evaluator: ids.evaluator }), `更新品类 ${cat.name}`);
}
console.log('✓ 演示品类已指派负责人');

// 3. 导入样例（表头是字段中文标签，按标签映射）
const mappingCache = {};
const mapping = async (object) => {
  if (!mappingCache[object]) {
    const meta = must(await api(admin, 'GET', `/meta/object/${object}`), `读元数据 ${object}`);
    mappingCache[object] = Object.fromEntries(Object.entries((meta.item ?? meta).fields).map(([n, f]) => [String(f.label), n]));
  }
  return mappingCache[object];
};
const importCsv = async (who, object, file, matchFields, skipBlankMatchKey = false) => {
  const body = { format: 'csv', csv: sample(file), mapping: await mapping(object), writeMode: 'upsert', matchFields, skipBlankMatchKey };
  const r = must(await api(tokens[who], 'POST', `/data/${object}/import`, body), `导入 ${file}`);
  const d = r.data ?? r;
  console.log(`✓ 导入 ${file.padEnd(30)} 新建 ${d.created ?? '-'} 更新 ${d.updated ?? '-'} 错误 ${d.errors ?? 0}`);
  if (d.errors) console.log(JSON.stringify((d.results ?? []).filter((x) => x.error || x.errors).slice(0, 5)));
};
await importCsv('srmadmin', 'srm_material', 'srm_material.csv', ['erp_material_no']);
await importCsv('srmadmin', 'srm_supplier', 'srm_supplier.csv', ['credit_code'], true);
await importCsv('srmadmin', 'srm_supplier', 'srm_supplier.csv', ['country', 'registration_no'], true);
await importCsv('srmadmin', 'srm_supplier_contact', 'srm_supplier_contact.csv', ['supplier', 'email']);
await importCsv('srmadmin', 'srm_supplier_certificate', 'srm_supplier_certificate.csv', ['supplier', 'cert_type', 'cert_no']);

// 物料按物料号前缀挂到演示品类（EX-1 电子、EX-2 包装、EX-3 工业品），自动开整改单时才能找到 SQE
const cats = Object.fromEntries(rows(must(await api(admin, 'GET', '/data/srm_category'), '读品类')).map((c) => [c.code, c.id]));
for (const m of rows(must(await api(admin, 'GET', '/data/srm_material?limit=200'), '读物料'))) {
  const code = { 1: 'ELEC', 2: 'PACK', 3: 'MRO' }[String(m.erp_material_no ?? '').charAt(3)];
  if (code && !m.category) must(await api(admin, 'PATCH', `/data/srm_material/${m.id}`, { category: cats[code] }), `物料 ${m.erp_material_no}`);
}
console.log('✓ 物料已关联品类');

await importCsv('cm', 'srm_contract', 'srm_contract.csv', ['title']);
await importCsv('cm', 'srm_contract_line', 'srm_contract_line.csv', ['contract', 'line_no']);
await importCsv('sqe', 'srm_delivery_record', 'srm_delivery_record.csv', ['erp_receipt_no', 'erp_order_no', 'erp_line_no']);

console.log(`\n完成。打开 ${BASE}/_console/ ，用上面任一账号和 HOTSRM_DEMO_PASSWORD 登录`);
