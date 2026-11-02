import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import * as objects from '../src/core/objects';
import { SupplierContact } from '../src/core/objects';
import { SrmPermissionSets } from '../src/core/security/permission-sets';
import { SrmPortalPermissionSets } from '../src/core/security/portal-permission-sets';
import { SrmPortalPositions, SrmPositions } from '../src/core/security/positions';
import { SrmSharingRules } from '../src/core/security/sharing-rules';

// 门户隔离验收（04 §3.7，ADR-0010）：供应商之间零可见是红线（AGENTS.md 红线 2），本文件不得删除或跳过。
// 门户用户按组织角色 external 邀请、任命到静态岗位 srm_portal_user；能看哪家供应商只由联系人上的 portal_user
// 决定（成员键 current_user.portal_supplier_ids）。取不到隔离依据的情形一律断言「零行」，不是「没有 B 的行」。

type Row = Record<string, any>;
type Rls = { name: string; object: string; operation: string; using?: string; check?: string };
type Access = { allowRead?: boolean; allowCreate?: boolean; allowEdit?: boolean; allowDelete?: boolean; viewAllRecords?: boolean; modifyAllRecords?: boolean; allowExport?: boolean };
type PortalSet = { name: string; objects: Record<string, Access>; rowLevelSecurity?: Rls[]; isDefault?: boolean };

const KEY = 'current_user.portal_supplier_ids';
const allObjects = Object.values(objects) as Array<{ name: string; sharingModel?: string; fields: Record<string, Row>; membershipKeys?: Row }>;
const objectNamed = (name: string) => allObjects.find((o) => o.name === name)!;
const portalSets = SrmPortalPermissionSets as unknown as PortalSet[];

// 面向供应商、带供应商引用但门户不可见的对象（04 §3.2 末行）：新增带 supplier 的对象时必须在门户权限集里授予，
// 或者在这里写明不授予的理由
const NOT_FOR_PORTAL: Record<string, string> = {
  srm_supplier_audit: '审核记录不对供应商开放',
  srm_supplier_audit_finding: '跟随审核',
  srm_risk_event: '内部风险评估',
  srm_supplier_disposition: '内部处置决定，结果体现在供应商状态上',
  srm_supplier_invitation: '内部的门户开通需求，门户经名册而不是邀请看到数据',
};

// controlled_by_parent 子对象的主记录字段
const masterOf = (name: string) => {
  const entry = Object.entries(objectNamed(name).fields).find(([, f]) => f.type === 'master_detail');
  return entry ? { field: entry[0], object: String(entry[1].reference) } : undefined;
};

describe('portal isolation metadata (ADR-0010)', () => {
  it('declares the membership key exactly once, on the contact roster, filtered to active contacts', () => {
    const declaring = allObjects.filter((o) => o.membershipKeys && 'portal_supplier_ids' in o.membershipKeys);
    expect(declaring.map((o) => o.name)).toEqual(['srm_supplier_contact']);
    expect(SupplierContact.membershipKeys!.portal_supplier_ids).toMatchObject({ userField: 'portal_user', valueField: 'supplier', filter: 'active == true' });
  });

  // 写 portal_user 就是授出一家供应商的门户数据：只能由 flow 写
  it('keeps the roster grant field writable by flows only', () => {
    expect(SupplierContact.fields.portal_user).toMatchObject({ type: 'user', readonly: true });
  });

  it('sets no portal permission set as the default and grants no delete, view-all, modify-all or export', () => {
    for (const set of portalSets) {
      expect('isDefault' in set, set.name).toBe(false);
      for (const [object, access] of Object.entries(set.objects)) {
        expect([access.allowDelete, access.viewAllRecords, access.modifyAllRecords, access.allowExport].some(Boolean), `${set.name}.${object}`).toBe(false);
      }
    }
  });

  // 每个门户能读的对象：要么是 controlled_by_parent 子对象（主记录本身受门户 RLS 约束），要么在同一个权限集里
  // 有读成员键的 select 策略。共享规则是全量授权，只有 RLS 把它限定到本公司，任何 PR 都不能悄悄去掉这条 RLS
  it('narrows every object a portal set can read with the membership key', () => {
    const anchored = new Set<string>();
    for (const set of portalSets) {
      const rls = set.rowLevelSecurity ?? [];
      for (const policy of rls) expect(policy.using, policy.name).toContain(KEY);
      for (const policy of rls.filter((p) => p.operation !== 'select')) expect(policy.check, policy.name).toContain(KEY);
      for (const policy of rls.filter((p) => p.operation === 'select')) anchored.add(policy.object);
    }
    const supplierSet = portalSets.find((s) => s.name === 'srm_portal_supplier')!;
    for (const set of portalSets) {
      for (const [object, access] of Object.entries(set.objects)) {
        if (!access.allowRead) continue;
        const master = masterOf(object);
        if (objectNamed(object).sharingModel === 'controlled_by_parent') {
          expect(master, object).toBeTruthy();
          expect(supplierSet.objects[master!.object]?.allowRead, `${object} → ${master!.object}`).toBe(true);
          expect(objectNamed(master!.object).sharingModel === 'controlled_by_parent' || anchored.has(master!.object), object).toBe(true);
        } else {
          expect(anchored.has(object), `${set.name}.${object} has no membership-key RLS`).toBe(true);
        }
        // 能写的对象必须有带 check 的写策略或是子对象（子对象写入要求主记录可编辑）
        if (access.allowEdit && objectNamed(object).sharingModel !== 'controlled_by_parent') {
          expect((set.rowLevelSecurity ?? []).some((p) => p.object === object && p.operation === 'update'), `${set.name}.${object}`).toBe(true);
        }
      }
    }
  });

  it('grants every supplier-facing object to the portal or names why not', () => {
    const supplierSet = portalSets.find((s) => s.name === 'srm_portal_supplier')!;
    for (const object of allObjects) {
      const refersToSupplier = Object.values(object.fields).some((f) => f.reference === 'srm_supplier');
      const viaParent = masterOf(object.name) && supplierSet.objects[masterOf(object.name)!.object];
      if (!refersToSupplier && !viaParent && object.name !== 'srm_supplier') continue;
      expect(Boolean(supplierSet.objects[object.name]?.allowRead) !== (object.name in NOT_FOR_PORTAL), object.name).toBe(true);
    }
  });

  it('shares with portal positions only read access on objects the membership RLS narrows', () => {
    const supplierSet = portalSets.find((s) => s.name === 'srm_portal_supplier')!;
    const portalRules = SrmSharingRules.filter((rule) => SrmPortalPositions.includes(rule.sharedWith.value));
    expect(portalRules.map((rule) => rule.object).sort()).toEqual(['srm_contract', 'srm_supplier_application', 'srm_supplier_change_request']);
    for (const rule of portalRules) {
      expect(rule.accessLevel, rule.name).toBe('read');
      expect(rule.sharedWith, rule.name).toEqual({ type: 'position', value: 'srm_portal_user' });
      expect((supplierSet.rowLevelSecurity ?? []).some((p) => p.object === rule.object && p.operation === 'select' && p.using?.includes(KEY)), rule.name).toBe(true);
    }
  });

  // 字段级权限里写的字段名都要存在，字段改名后不能静默失效
  it('names only existing fields in the portal field permissions', () => {
    for (const set of SrmPortalPermissionSets as unknown as Array<{ name: string; fields?: Record<string, unknown> }>) {
      for (const key of Object.keys(set.fields ?? {})) {
        const [object, field] = key.split('.');
        expect(objectNamed(object!)?.fields[field!], `${set.name} ${key}`).toBeTruthy();
      }
    }
  });

  // 门户能改的整改单字段只有供应商回复与状态（v0.6 U5）；索赔、SQE 意见、期限等一律只读
  it('lets the portal edit only the SCAR response fields', () => {
    const supplierSet = SrmPortalPermissionSets.find((s) => s.name === 'srm_portal_supplier') as unknown as { fields: Record<string, { editable: boolean }> };
    const issue = objectNamed('srm_quality_issue');
    const editable = Object.keys(issue.fields).filter((field) => supplierSet.fields[`srm_quality_issue.${field}`]?.editable !== false);
    expect(editable.sort()).toEqual(['containment_action', 'corrective_action', 'evidence', 'preventive_action', 'root_cause', 'status']);
  });

  // 以系统身份运行、门户能发起的 screen flow 读不到成员键，只能自己查名册：条件必须与成员键的名册条件一致
  it('makes every portal-facing system flow check the contact roster like the membership key', () => {
    const key = SupplierContact.membershipKeys!.portal_supplier_ids as { userField: string; valueField: string; filter: string };
    expect(key.filter).toBe('active == true');
    for (const name of ['srm_claim_respond', 'srm_appeal_submit', 'srm_change_submit', 'srm_application_resubmit', 'srm_application_submit']) {
      const flow = (config.flows ?? []).find((f) => f.name === name)!;
      expect(flow.runAs, name).toBe('system');
      const roster = flow.nodes.find((n) => n.id === 'load_membership') as { config: { objectName: string; filter: Row } } | undefined;
      expect(roster?.config.objectName, name).toBe('srm_supplier_contact');
      expect(Object.keys(roster!.config.filter).sort(), name).toEqual(['active', key.userField, key.valueField].sort());
      expect(roster!.config.filter.active, name).toBe(true);
      // 每条走到界面或写入的路径都经过 membership 判断
      const gate = flow.edges.filter((e) => e.source === 'gate');
      for (const edge of gate) expect(JSON.stringify(edge.condition), `${name} ${edge.id}`).toContain('membership');
    }
  });

  it('keeps portal and internal positions apart', () => {
    const portalSetNames = new Set(portalSets.map((s) => s.name));
    for (const position of SrmPositions) {
      const mountsPortal = position.permissionSets.filter((name) => portalSetNames.has(name));
      if (SrmPortalPositions.includes(position.name)) expect(mountsPortal, position.name).toEqual(position.permissionSets);
      else expect(mountsPortal, position.name).toEqual([]);
    }
    // 内部权限集不出现成员键（门户的行范围不与内部权限混用）
    for (const set of SrmPermissionSets.filter((s) => !portalSetNames.has(s.name)) as unknown as PortalSet[]) {
      for (const policy of set.rowLevelSecurity ?? []) expect(policy.using ?? '', policy.name).not.toContain(KEY);
    }
  });
});

describe('portal isolation (04 §3.7)', () => {
  let stack: VerifyStack;
  let admin: string;
  let seq = 0;
  let org: Record<string, string> = {};

  const sys = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as Row;
  const seed = async (object: string, doc: Row) => (await stack.seed(object, [doc]))[0] as Row;
  // 证书扫描件：一条文件记录只能被一个字段引用，每张证书各建一条
  const scan = async () => {
    const name = `portal-scan-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [{ key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' }]);
    return String(file?.id);
  };
  const assign = (userId: string, position: string) => stack.seed('sys_user_position', [{ user_id: userId, position, ...org }]);

  // 门户用户：注册 → 组织角色改为 external → 任命门户岗位 → 在供应商联系人上登记 portal_user
  type Portal = { token: string; id: string; contact?: string };
  const portalUser = async (supplier: string | null, opts: { positions?: string[]; contact?: Row } = {}): Promise<Portal> => {
    const token = await stack.signUp(`portal-${++seq}@example.com`);
    const ctx = await stack.contextFor(token);
    const id = String(ctx.userId);
    const changed = await stack.hooks.updateWhere('sys_member', { user_id: id }, { role: 'external' }, { system: true });
    expect(changed).toBe(1);
    for (const position of opts.positions ?? ['srm_portal_user']) await assign(id, position);
    if (!supplier) return { token, id };
    const contact = await sys(SupplierContact.name, { supplier, name: `门户联系人 ${seq}`, email: `portal-${seq}@example.com`, portal_user: id, ...opts.contact });
    return { token, id, contact: String(contact.id) };
  };
  const internal = async (position: string) => {
    const token = await stack.signUp(`internal-${position}-${++seq}@example.com`);
    await assign(String((await stack.contextFor(token)).userId), position);
    return token;
  };

  // 每家供应商一套门户对象的记录；visible = 门户应当看到的，hidden = 本公司但状态不可见的
  type Docs = { supplier: string; name: string; visible: Map<string, string[]>; hidden: Map<string, string[]> };
  let category: string;
  let material: string;
  let kpi: string;
  const docsFor = async (label: string): Promise<Docs> => {
    const n = ++seq;
    const name = `示例门户隔离${label}有限公司 ${n}`;
    // 先以「潜在」建档并建准入申请，再推进到合格（合同要求合格供应商）
    const supplier = String((await sys('srm_supplier', { name, credit_code: `91000000MA0ISO${String(n).padStart(4, '0')}` })).id);
    const application = await seed('srm_supplier_application', { supplier, applied_categories: [category], status: 'doc_review' });
    for (const status of ['qualifying', 'qualified']) await stack.hooks.run('srm_supplier', 'update', { id: supplier, status }, { system: true });
    const visible = new Map<string, string[]>();
    const hidden = new Map<string, string[]>();
    const put = (map: Map<string, string[]>, object: string, row: Row) => map.set(object, [...(map.get(object) ?? []), String(row.id)]);
    put(visible, 'srm_supplier', { id: supplier });
    put(visible, 'srm_supplier_contact', await sys('srm_supplier_contact', { supplier, name: `业务联系人 ${n}`, email: `biz-${n}@example.com` }));
    put(visible, 'srm_supplier_certificate', await sys('srm_supplier_certificate', { supplier, cert_type: 'iso9001', cert_no: `ISO-${n}`, valid_to: '2030-12-31', legacy_imported: true }));
    put(visible, 'srm_supplier_category', await seed('srm_supplier_category', { supplier, category, status: 'qualified' }));
    put(visible, 'srm_supplier_bank_account', await sys('srm_supplier_bank_account', { supplier, bank_name: '示例银行', account_name: name, account_no: `62220000${String(n).padStart(8, '0')}` }));
    put(visible, 'srm_supplier_application', application);
    put(visible, 'srm_supplier_change_request', await seed('srm_supplier_change_request', { supplier, change_type: 'basic', reason: '示例变更', new_name: `${name}（新）` }));
    // 合同明细只能挂在草稿合同上：两份都先建草稿和明细，再把一份推进到签署中
    const contract = async () => {
      const row = await seed('srm_contract', { title: `示例门户合同 ${++seq}`, contract_type: 'purchase', supplier, start_date: '2026-01-01', end_date: '2026-12-31' });
      const line = await sys('srm_contract_line', { contract: row.id, line_no: 1, description: '示例物资', quantity: 1, unit_price: 1 });
      return { row, line };
    };
    const signing = await contract();
    const draft = await contract();
    for (const status of ['in_review', 'signing']) await stack.hooks.run('srm_contract', 'update', { id: signing.row.id, status }, { system: true });
    put(visible, 'srm_contract', signing.row);
    put(hidden, 'srm_contract', draft.row);
    put(visible, 'srm_contract_line', signing.line);
    put(hidden, 'srm_contract_line', draft.line);
    put(
      visible,
      'srm_delivery_record',
      await sys('srm_delivery_record', {
        erp_receipt_no: `ISO${String(n).padStart(7, '0')}`,
        erp_order_no: '4500099999',
        erp_line_no: '10',
        supplier,
        material,
        required_date: '2026-09-10',
        receipt_date: '2026-09-10',
        received_quantity: 10,
      }),
    );
    put(visible, 'srm_quality_issue', await sys('srm_quality_issue', { supplier, severity: 'minor', problem_description: `示例门户隔离问题 ${n}` }));
    const review = (period: string, status: string) => seed('srm_performance_review', { supplier, cycle: 'monthly', period, status });
    const published = await review('2026-08', 'published');
    const scoring = await review('2026-09', 'scoring');
    put(visible, 'srm_performance_review', published);
    put(hidden, 'srm_performance_review', scoring);
    put(visible, 'srm_performance_score', await seed('srm_performance_score', { review: published.id, kpi }));
    put(hidden, 'srm_performance_score', await seed('srm_performance_score', { review: scoring.id, kpi }));
    return { supplier, name, visible, hidden };
  };

  const PORTAL_OBJECTS = Object.keys(portalSets.find((s) => s.name === 'srm_portal_supplier')!.objects);
  const idsOf = (rows: Row[]) => rows.map((r) => String(r.id));
  const all = (docs: Docs) => [...docs.visible.values(), ...docs.hidden.values()].flat();

  let A: Docs;
  let B: Docs;
  let N: Docs; // 没开通门户的供应商
  let a: Portal;
  let aAdmin: Portal;
  let b: Portal;

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
    const ctx = await stack.contextFor(admin);
    org = ctx.tenantId ? { organization_id: String(ctx.tenantId) } : {};
    category = String((await sys('srm_category', { code: `ISO${++seq}`, name: `示例门户隔离品类 ${seq}` })).id);
    material = String((await sys('srm_material', { erp_material_no: `ISO-${++seq}`, material_code: `ISO${seq}`, name: '示例物料' })).id);
    kpi = String((await stack.rows('srm_kpi'))[0]!.id);
    A = await docsFor('甲');
    B = await docsFor('乙');
    N = await docsFor('丙');
    a = await portalUser(A.supplier);
    aAdmin = await portalUser(A.supplier, { positions: ['srm_portal_user', 'srm_portal_admin'], contact: { contact_function: ['admin'] } });
    b = await portalUser(B.supplier);
    A.visible.get('srm_supplier_contact')!.push(a.contact!, aAdmin.contact!);
    B.visible.get('srm_supplier_contact')!.push(b.contact!);
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  const list = (token: string, object: string) => stack.rows(object, {}, { as: token });
  const expectNothing = async (token: string) => {
    for (const object of PORTAL_OBJECTS) {
      const rows = await list(token, object).catch((e) => {
        // 没有门户岗位时整个对象都无权访问，同样是零行
        expect(e.code, object).toBe('PERMISSION_DENIED');
        return [];
      });
      expect(rows, object).toEqual([]);
    }
  };

  it('resolves a portal user as external, without the everyone anchor', async () => {
    const ctx = (await stack.contextFor(a.token)) as { positions?: string[] };
    expect(ctx.positions).toContain('org_external');
    expect(ctx.positions).toContain('srm_portal_user');
    expect(ctx.positions).not.toContain('everyone');
  });

  // 交叉读：A 的身份列表只出现 A 的行（且确实能看到 A 的可见行），按 id 读 B、未开通供应商的行一律不存在
  it('lists only the own supplier rows on every portal object', async () => {
    for (const object of PORTAL_OBJECTS) {
      const seen = idsOf(await list(a.token, object));
      expect(seen.length, object).toBeGreaterThan(0);
      for (const id of A.visible.get(object) ?? []) expect(seen, `${object} own`).toContain(id);
      const foreign = [...all(B), ...all(N), ...(A.hidden.get(object) ?? [])];
      expect(seen.filter((id) => foreign.includes(id)), object).toEqual([]);
      // 应用自带的示例数据（种子供应商等）同样看不到
      const own = new Set([...A.visible.values()].flat());
      expect(seen.filter((id) => !own.has(id)), `${object} extra rows`).toEqual([]);
    }
  });

  it('answers not found for another supplier\'s record by id, over the engine and REST', async () => {
    for (const object of PORTAL_OBJECTS) {
      for (const id of [...(B.visible.get(object) ?? []), ...(N.visible.get(object) ?? [])]) {
        expect(await stack.rows(object, { id }, { as: a.token }), `${object} ${id}`).toEqual([]);
        const res = await stack.apiAs(a.token, 'GET', `/data/${object}/${id}`);
        expect(res.status, `${object} ${id}`).toBe(404);
      }
    }
  });

  it('keeps unpublished reviews, draft contracts and their child rows out of the portal', async () => {
    for (const [object, ids] of A.hidden) {
      for (const id of ids) expect(await stack.rows(object, { id }, { as: a.token }), `${object} ${id}`).toEqual([]);
    }
  });

  it('applies the same isolation to REST list, search and query', async () => {
    const names = async (res: Response) => {
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { records?: Row[]; data?: { records?: Row[] } };
      return (body.records ?? body.data?.records ?? []).map((r) => String(r.name));
    };
    expect(await names(await stack.apiAs(a.token, 'GET', '/data/srm_supplier'))).toEqual([A.name]);
    const search = await stack.apiAs(a.token, 'GET', `/data/srm_supplier?search=${encodeURIComponent('示例门户隔离')}`);
    expect(await names(search)).toEqual([A.name]);
    expect(await names(await stack.apiAs(a.token, 'POST', '/data/srm_supplier/query', {}))).toEqual([A.name]);
    for (const object of PORTAL_OBJECTS) {
      const res = await stack.apiAs(a.token, 'GET', `/data/${object}`);
      expect(res.status, object).toBe(200);
      const body = (await res.json()) as { records?: Row[] };
      expect(idsOf(body.records ?? []).filter((id) => [...all(B), ...all(N)].includes(id)), object).toEqual([]);
    }
  });

  // 导出：门户权限集一律不授 allowExport
  it('refuses export to a portal user', async () => {
    for (const object of ['srm_supplier', 'srm_contract', 'srm_quality_issue']) {
      const res = await stack.apiAs(a.token, 'GET', `/data/${object}/export`);
      expect(res.status, object).toBe(403);
    }
  });

  // 交叉写：改 B 的记录、把自己的记录挂到 B 名下，一律拒绝；改自己的资料字段放行
  it('refuses writes to another supplier and keeps own writes on the own supplier', async () => {
    await expect(stack.hooks.run('srm_supplier', 'update', { id: B.supplier, website: 'https://b.example.com' }, { as: a.token })).rejects.toBeTruthy();
    const own = await stack.hooks.run('srm_supplier', 'update', { id: A.supplier, website: 'https://a.example.com' }, { as: a.token });
    expect(own.website).toBe('https://a.example.com');
    // 关键信息只读（04 §4.2）
    await expect(stack.hooks.run('srm_supplier', 'update', { id: A.supplier, name: '改名' }, { as: a.token })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      stack.hooks.run('srm_supplier_certificate', 'insert', { supplier: B.supplier, cert_type: 'iso14001', cert_no: 'X', valid_to: '2030-01-01', legacy_imported: false }, { as: a.token }),
    ).rejects.toBeTruthy();
    for (const object of ['srm_quality_issue', 'srm_contract', 'srm_delivery_record', 'srm_performance_review']) {
      const id = A.visible.get(object)![0]!;
      await expect(stack.hooks.run(object, 'update', { id, supplier: B.supplier }, { as: a.token }), object).rejects.toBeTruthy();
      await expect(stack.hooks.run(object, 'update', { id: B.visible.get(object)![0]!, supplier: A.supplier }, { as: a.token }), object).rejects.toBeTruthy();
    }
    const rows = await stack.rows('srm_supplier', { id: B.supplier });
    expect(rows[0]!.website ?? null).toBeNull();
  });

  // 整改单回复（v0.6 U5）：只能改本公司、轮到供应商回复的单，只能改回复字段，状态只能走供应商的两步
  it('limits SCAR replies to the own supplier, the supplier\'s turn and the response fields', async () => {
    // 种子写入直接给定状态（不触发审核流程）；本公司新建的单记入 A 的可见行
    const issue = async (supplier: string, doc: Row = {}) => {
      const id = String((await seed('srm_quality_issue', { supplier, severity: 'major', problem_description: '示例门户回复隔离', ...doc })).id);
      (supplier === A.supplier ? A : B).visible.get('srm_quality_issue')!.push(id);
      return id;
    };
    const write = (id: string, doc: Row) => stack.hooks.run('srm_quality_issue', 'update', { id, ...doc }, { as: a.token });
    const stored = async (id: string) => (await stack.rows('srm_quality_issue', { id }))[0]!;
    // 别家的单：改不了，也提交不了
    const foreign = await issue(B.supplier);
    await expect(write(foreign, { containment_action: '越权回复' })).rejects.toBeTruthy();
    await expect(write(foreign, { status: 'containment_submitted' })).rejects.toBeTruthy();
    expect(await stored(foreign)).toMatchObject({ status: 'open' });
    expect((await stored(foreign)).containment_action ?? null).toBeNull();

    const own = await issue(A.supplier);
    // 不是回复字段：拒绝或被丢弃，值不变
    for (const doc of [{ sqe_comment: '自填意见' }, { claim_amount: 1 }, { claim_status: 'supplier_accepted' }, { problem_description: '改问题' }, { is_overdue: true }, { supplier: B.supplier }]) {
      await write(own, doc).catch(() => undefined);
      const after = await stored(own);
      for (const [field, value] of Object.entries(doc)) expect(after[field], field).not.toEqual(value);
    }
    // 状态不能跳过审核、不能撤销或关闭
    for (const status of ['action_submitted', 'verifying', 'closed', 'cancelled']) {
      await expect(write(own, { containment_action: '示例临时措施', status }), status).rejects.toBeTruthy();
    }
    await write(own, { containment_action: '示例临时措施', status: 'containment_submitted' });
    // 提交后不能自己退回
    await expect(write(own, { status: 'open' })).rejects.toBeTruthy();
    expect((await stored(own)).status).toBe('containment_submitted');
    // 轮到 SQE（效果验证、已关闭）时整张单都改不了
    for (const status of ['action_submitted', 'verifying', 'closed', 'cancelled']) {
      const locked = await issue(A.supplier, { containment_action: '示例', root_cause: '示例', corrective_action: '示例', status });
      await expect(write(locked, { preventive_action: '改' }), status).rejects.toBeTruthy();
      expect((await stored(locked)).preventive_action ?? null, status).toBeNull();
    }
  });

  // 系统身份运行的 screen flow 自己做隔离检查：别家的整改单、考评单一律拒绝，记录不变
  it('refuses the claim and appeal flows on another supplier\'s records', async () => {
    // 两个入口都试：记录页按钮（action）和直接触发 flow（REST trigger，不经按钮所在页面的读取）。flow 以系统身份
    // 读记录，所以隔离只能靠 flow 自己的名册检查
    const run = async (who: Portal, object: string, flow: string, recordId: string, input: Row) => {
      const finish = async (start: Promise<unknown>) => {
        let res = (await start.catch((e) => ({ status: 'error', error: e }))) as Row;
        for (let i = 0; i < 3 && res.status === 'paused' && res.runId; i++) {
          res = (await stack.flows.resume({ flowName: flow, runId: res.runId }, input, { as: who.token }).catch((e) => ({ status: 'error', error: e }))) as Row;
        }
        return String(res.status ?? (res.success === true ? 'completed' : 'failed'));
      };
      return {
        // 按钮入口：记录对门户不可见，平台答「不存在」；直接触发：flow 的名册检查拒绝
        status: [
          await finish(stack.actions.run(object, flow, { as: who.token, recordId })),
          await finish(stack.flows.run(flow, { recordId }, { as: who.token })),
        ],
      };
    };
    const REFUSED = { status: ['error', 'refused'] };
    const foreign = String((await sys('srm_quality_issue', { supplier: B.supplier, severity: 'major', problem_description: '示例索赔隔离', claim_amount: 100, claim_status: 'proposed' })).id);
    B.visible.get('srm_quality_issue')!.push(foreign);
    expect(await run(a, 'srm_quality_issue', 'srm_claim_respond', foreign, { decision: 'accept' })).toEqual(REFUSED);
    expect((await stack.rows('srm_quality_issue', { id: foreign }))[0]!.claim_status).toBe('proposed');

    const today = new Date().toISOString().slice(0, 10);
    const review = B.visible.get('srm_performance_review')![0]!;
    await stack.hooks.run('srm_performance_review', 'update', { id: review, published_date: today }, { system: true });
    expect((await run(aAdmin, 'srm_performance_review', 'srm_appeal_submit', review, { appeal_text: '越权申诉' }))).toEqual(REFUSED);
    expect((await stack.rows('srm_performance_review', { id: review }))[0]!).toMatchObject({ status: 'published' });
    expect((await stack.rows('srm_performance_review', { id: review }))[0]!.appeal_reason ?? null).toBeNull();
    // 联系人停用后，同一个门户管理员对本公司的考评单也申诉不了
    const own = A.visible.get('srm_performance_review')![0]!;
    await stack.hooks.run('srm_performance_review', 'update', { id: own, published_date: today }, { system: true });
    await stack.hooks.run('srm_supplier_contact', 'update', { id: aAdmin.contact, active: false }, { system: true });
    expect((await run(aAdmin, 'srm_performance_review', 'srm_appeal_submit', own, { appeal_text: '停用后申诉' }))).toEqual(REFUSED);
    // 停用同时清掉了 portal_user（srm_portal_contact_revoke），恢复在职后要重新登记名册（实际经「开通门户」，这里直接以系统身份写）
    await stack.hooks.run('srm_supplier_contact', 'update', { id: aAdmin.contact, active: true }, { system: true });
    await stack.hooks.run('srm_supplier_contact', 'update', { id: aAdmin.contact, portal_user: aAdmin.id }, { system: true });
    expect((await stack.rows('srm_performance_review', { id: own }))[0]!.status).toBe('published');
    // 对照：恢复在职并重新登记后，本公司的考评单经按钮能申诉，说明上面的拒绝来自隔离检查而不是入口本身不通
    expect((await run(aAdmin, 'srm_performance_review', 'srm_appeal_submit', own, { appeal_text: '示例申诉' })).status[0]).toBe('completed');
    expect((await stack.rows('srm_performance_review', { id: own }))[0]!).toMatchObject({ status: 'appealed', appeal_recorded_by: aAdmin.id });
  });

  // 名册就是授权：任何门户身份、任何内部岗位都写不了 portal_user，也改不了联系人归属和在职标志
  it('lets nobody but a flow grant portal access through the contact roster', async () => {
    await expect(
      stack.hooks.run('srm_supplier_contact', 'insert', { supplier: B.supplier, name: '冒名', email: 'x@example.com' }, { as: aAdmin.token }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // portal_user 是只读字段：门户送来的值被平台丢弃，新联系人不带门户账号
    const forged = await stack.hooks
      .run('srm_supplier_contact', 'insert', { supplier: A.supplier, name: '冒名', email: 'y@example.com', portal_user: b.id }, { as: aAdmin.token })
      .catch(() => undefined);
    if (forged) {
      expect(forged.portal_user ?? null).toBeNull();
      A.visible.get('srm_supplier_contact')!.push(String(forged.id));
    }
    expect(idsOf(await list(b.token, 'srm_supplier'))).toEqual([B.supplier]);
    await expect(stack.hooks.run('srm_supplier_contact', 'update', { id: a.contact, supplier: B.supplier }, { as: aAdmin.token })).rejects.toBeTruthy();
    await stack.hooks.run('srm_supplier_contact', 'update', { id: a.contact, portal_user: aAdmin.id }, { as: aAdmin.token }).catch(() => undefined);
    expect((await stack.rows('srm_supplier_contact', { id: a.contact }))[0]!.portal_user).toBe(a.id);
    await expect(stack.hooks.run('srm_supplier_contact', 'update', { id: a.contact, active: false }, { as: aAdmin.token })).rejects.toBeTruthy();
    // 门户管理员能在本公司下新增联系人，但新联系人不带门户账号
    const added = await stack.hooks.run('srm_supplier_contact', 'insert', { supplier: A.supplier, name: '新联系人', email: 'new@example.com' }, { as: aAdmin.token });
    expect(added.portal_user ?? null).toBeNull();
    A.visible.get('srm_supplier_contact')!.push(String(added.id));
    // 普通门户用户连联系人都建不了
    await expect(
      stack.hooks.run('srm_supplier_contact', 'insert', { supplier: A.supplier, name: '普通用户建', email: 'z@example.com' }, { as: a.token }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // 内部维护联系人的岗位同样写不了 portal_user
    const manager = await internal('srm_category_manager');
    const internalContact = B.visible.get('srm_supplier_contact')![0]!;
    await stack.hooks.run('srm_supplier_contact', 'update', { id: internalContact, portal_user: a.id }, { as: manager }).catch(() => undefined);
    expect((await stack.rows('srm_supplier_contact', { id: internalContact }))[0]!.portal_user ?? null).toBeNull();
    expect(idsOf(await list(a.token, 'srm_supplier'))).toEqual([A.supplier]);
  });

  // controlled_by_parent 的写入（07 §6.2 V4）：主记录可编辑即可在本公司名下新建子记录
  it('lets a portal user upload a certificate under the own supplier, unverified', async () => {
    const created = await stack.hooks.run(
      'srm_supplier_certificate',
      'insert',
      { supplier: A.supplier, cert_type: 'iso14001', cert_no: `ISO14-${++seq}`, valid_to: '2030-01-01', attachment: await scan() },
      { as: a.token },
    );
    expect(created.verified).toBe(false);
    A.visible.get('srm_supplier_certificate')!.push(String(created.id));
    expect(idsOf(await list(b.token, 'srm_supplier_certificate'))).not.toContain(String(created.id));
  });

  // 自解资质异常：门户上传的新证书不能自带「已核验」或状态；改已有证书的内容会复位「已核验」（v0.6 U4，03 §11），
  // 状态门户改不了。资质异常要经 SQE 核验才解除，完整场景见 portal-self-service.test.ts
  it('does not let a portal user clear a qualification alert', async () => {
    const certificate = A.visible.get('srm_supplier_certificate')![0]!;
    expect((await stack.rows('srm_supplier_certificate', { id: certificate }))[0]!.verified).toBe(true);
    await stack.hooks.run('srm_supplier_certificate', 'update', { id: certificate, valid_to: '2040-01-01' }, { as: a.token });
    expect((await stack.rows('srm_supplier_certificate', { id: certificate }))[0]!.verified).toBe(false);
    await expect(stack.hooks.run('srm_supplier_certificate', 'update', { id: certificate, status: 'valid' }, { as: a.token })).rejects.toBeTruthy();
    await expect(
      stack.hooks.run(
        'srm_supplier_certificate',
        'insert',
        { supplier: A.supplier, cert_type: 'iso14001', cert_no: 'ISO14-1', valid_to: '2030-01-01', legacy_imported: true, verified: true },
        { as: a.token },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  // v0.6 U4 的写路径（04 §3.7）：改别家的证书、联系人、变更单，在别家名下建银行账户，经 screen flow 给别家提交变更或
  // 重新提交别家的准入申请，一律拒绝；别家的记录一个字段都不变
  it('refuses the self-service write paths across suppliers', async () => {
    const bCert = B.visible.get('srm_supplier_certificate')![0]!;
    await expect(stack.hooks.run('srm_supplier_certificate', 'update', { id: bCert, valid_to: '2041-01-01' }, { as: a.token })).rejects.toBeTruthy();
    // 把自己的证书改挂到别家名下
    const own = A.visible.get('srm_supplier_certificate')![0]!;
    await expect(stack.hooks.run('srm_supplier_certificate', 'update', { id: own, supplier: B.supplier }, { as: a.token })).rejects.toBeTruthy();
    const bContact = B.visible.get('srm_supplier_contact')![0]!;
    await expect(stack.hooks.run('srm_supplier_contact', 'update', { id: bContact, mobile: '13000000000' }, { as: aAdmin.token })).rejects.toBeTruthy();
    await expect(
      stack.hooks.run('srm_supplier_bank_account', 'insert', { supplier: B.supplier, bank_name: '示例银行', account_name: B.name, account_no: '6222000011112222' }, { as: aAdmin.token }),
    ).rejects.toBeTruthy();
    const bChange = B.visible.get('srm_supplier_change_request')![0]!;
    await expect(stack.hooks.run('srm_supplier_change_request', 'update', { id: bChange, reason: '冒名' }, { as: aAdmin.token })).rejects.toBeTruthy();
    // 系统身份的 screen flow：门户管理员伪造别家的供应商、门户用户伪造别家的准入申请，名册对不上即结束
    const submit = (await stack.flows.run('srm_change_submit', { recordId: B.supplier }, { as: aAdmin.token })) as { status?: string };
    expect(submit.status).toBe('refused');
    const resubmit = (await stack.flows.run('srm_application_resubmit', { recordId: B.visible.get('srm_supplier_application')![0]! }, { as: a.token })) as { status?: string };
    expect(resubmit.status).toBe('refused');
    // 核验证书只给 SQE / 质量经理
    const verify = (await stack.flows.run('srm_certificate_verify', { recordId: own }, { as: aAdmin.token })) as { status?: string };
    expect(verify.status).toBe('refused');
    expect((await stack.rows('srm_supplier_certificate', { id: bCert }))[0]!.valid_to).not.toBe('2041-01-01');
    expect((await stack.rows('srm_supplier_contact', { id: bContact }))[0]!.mobile ?? null).toBeNull();
    expect((await stack.rows('srm_supplier_change_request', { id: bChange }))[0]!.reason).toBe('示例变更');
    expect(await stack.rows('srm_supplier_change_request', { supplier: B.supplier })).toHaveLength(1);
    expect((await stack.rows('srm_supplier_bank_account', { supplier: B.supplier })).map((r) => String(r.id))).toEqual(B.visible.get('srm_supplier_bank_account'));
  });

  it('shows the full bank account number to the portal admin only', async () => {
    const id = A.visible.get('srm_supplier_bank_account')![0]!;
    const [full] = await stack.rows('srm_supplier_bank_account', { id }, { as: aAdmin.token });
    const [masked] = await stack.rows('srm_supplier_bank_account', { id }, { as: a.token });
    expect(String(full!.account_no)).toMatch(/^62220000\d{8}$/);
    expect(String(masked!.account_no)).not.toBe(String(full!.account_no));
    expect(String(masked!.account_no)).toMatch(/\d{4}$/);
  });

  // 空名册：持门户岗位但没有在职联系人的用户，成员键为空，平台丢弃全部门户策略
  it('shows nothing to a portal user who is on no roster', async () => {
    await expectNothing((await portalUser(null)).token);
  });

  it('shows nothing to a portal user whose contact is inactive', async () => {
    await expectNothing((await portalUser(B.supplier, { contact: { active: false } })).token);
  });

  it('shows nothing to an external user listed on a roster but holding no portal position', async () => {
    await expectNothing((await portalUser(B.supplier, { positions: [] })).token);
  });

  // 回收：停用联系人、撤销任命，下一个请求立即生效
  it('cuts access on the next request when the contact is deactivated or the position revoked', async () => {
    const c = await portalUser(B.supplier);
    expect(idsOf(await list(c.token, 'srm_supplier'))).toEqual([B.supplier]);
    await stack.hooks.run('srm_supplier_contact', 'update', { id: c.contact, active: false }, { system: true });
    await expectNothing(c.token);
    // 停用时 srm_portal_contact_revoke 同时清掉 portal_user：改回在职也不恢复门户访问，重新开通要走「开通门户」（04 §3.3）
    expect((await stack.rows('srm_supplier_contact', { id: c.contact }))[0]!.portal_user ?? null).toBeNull();
    await stack.hooks.run('srm_supplier_contact', 'update', { id: c.contact, active: true }, { system: true });
    await expectNothing(c.token);
    await stack.hooks.run('srm_supplier_contact', 'update', { id: c.contact, portal_user: c.id }, { system: true });
    expect(idsOf(await list(c.token, 'srm_supplier'))).toEqual([B.supplier]);
    await stack.hooks.updateWhere('sys_user_position', { user_id: c.id, position: 'srm_portal_user' }, { active: false }, { system: true }).catch(() => 0);
    const [assignment] = await stack.rows('sys_user_position', { user_id: c.id, position: 'srm_portal_user' });
    if (assignment) await stack.hooks.run('sys_user_position', 'delete', { id: assignment.id }, { system: true });
    await expectNothing(c.token);
  });

  // 淘汰 / 黑名单：执行处置时清掉该供应商联系人上的门户账号，不靠人工停用联系人（ADR-0010，04 §3.3）
  it('revokes portal access when a supplier is eliminated', async () => {
    const E = await docsFor('丁');
    const e = await portalUser(E.supplier);
    expect(idsOf(await list(e.token, 'srm_supplier'))).toEqual([E.supplier]);
    const disposition = await seed('srm_supplier_disposition', { supplier: E.supplier, action: 'eliminate', scope: 'all', reason: '示例淘汰', status: 'in_review' });
    const run = await stack.flows.run('srm_disposition_apply', { recordId: disposition.id }, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
    expect((await stack.rows('srm_supplier', { id: E.supplier }))[0]!.status).toBe('eliminated');
    expect((await stack.rows('srm_supplier_contact', { id: e.contact }))[0]!.portal_user ?? null).toBeNull();
    await expectNothing(e.token);
    // 其他供应商的门户不受影响
    expect(idsOf(await list(a.token, 'srm_supplier'))).toEqual([A.supplier]);
  });

  // 用户目录（04 §3.6）：external 只读自己的身份行
  it('shows a portal user no other users or members', async () => {
    for (const object of ['sys_user', 'sys_member']) {
      const res = await stack.apiAs(a.token, 'GET', `/data/${object}`);
      const body = res.status === 200 ? ((await res.json()) as { records?: Row[] }) : { records: [] };
      const others = (body.records ?? []).filter((r) => String(r.id) !== a.id && String(r.user_id ?? '') !== a.id);
      expect(others, object).toEqual([]);
    }
  });

  // 内部岗位不回归：内部员工照常看到全部供应商与合同
  it('leaves internal reads unchanged', async () => {
    const buyer = await internal('srm_buyer');
    const suppliers = idsOf(await list(buyer, 'srm_supplier'));
    expect(suppliers).toEqual(expect.arrayContaining([A.supplier, B.supplier, N.supplier]));
    const contracts = idsOf(await list(buyer, 'srm_contract'));
    expect(contracts).toEqual(expect.arrayContaining([...A.visible.get('srm_contract')!, ...A.hidden.get('srm_contract')!, ...B.visible.get('srm_contract')!]));
    expect(idsOf(await list(admin, 'srm_supplier_contact'))).toEqual(expect.arrayContaining([a.contact, b.contact]));
  });
});
