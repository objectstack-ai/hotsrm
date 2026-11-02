import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import { cel, composeStacks, defineStack } from '@objectstack/spec';
import { Field } from '@objectstack/spec/data';
import { stacks } from '../objectstack.composition';
import { Supplier, SupplierBankAccount, SupplierCertificate, SupplierContact } from '../src/core/objects';

// v0.6 U1（#77）：门户上线前的平台实测 V1–V5（07 §6.2），在 ObjectStack 18.1.0 上走真实的权限路径。
// 结论写在 07 §6.2「结果」列；U2（隔离基础）、U3（门户开通）直接复用这里的夹具：
// - 门户用户经真实的组织邀请（角色 external）注册并接受邀请进组织，不是直接改成员表；
// - 环境的成员策略为 invite-only（04 §3.3 开通前提）：注册不自动入组织，接受邀请才入，且以 external 入；
// - 门户岗位、门户权限集、supplier.portal_position 在这里是测平台行为用的实测夹具（PROBE 模块，方案 A 的形状），不是应用元数据；
//   正式元数据（ADR-0010）的隔离验收见 test/portal-isolation.test.ts。
process.env.OS_AUTH_MEMBERSHIP_POLICY = 'invite-only';

const SYS = { context: { isSystem: true } };
const PASSWORD = 'Portal!Probe123';
const OWN = 'portal_position in current_user.positions';

// 一个只有一个写节点的 screen flow：「开通门户」screen flow 最终要写的就是这几类身份行（04 §3.3 第 3 步）
const writeFlow = (name: string, runAs: 'system' | 'user', objectName: string, fields: Record<string, unknown>, inputs: string[]) => ({
  name,
  label: name,
  type: 'screen',
  status: 'active',
  runAs,
  variables: inputs.map((input) => ({ name: input, type: 'text', isInput: true, isOutput: false })),
  nodes: [
    { id: 'start', type: 'start', label: 'start' },
    { id: 'write', type: 'create_record', label: 'write', config: { objectName, fields, outputVariable: 'row' } },
    { id: 'end', type: 'end', label: 'end' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'write', type: 'default' },
    { id: 'e2', source: 'write', target: 'end', type: 'default' },
  ],
});
const assignment = { user_id: cel`userId`, position: cel`position`, organization_id: cel`orgId` };
const grant = { user_id: cel`userId`, permission_set: cel`permissionSet`, organization_id: cel`orgId` };
const invitation = {
  organization_id: cel`orgId`,
  email: cel`email`,
  role: 'external',
  status: 'pending',
  inviter_id: cel`inviterId`,
  expires_at: cel`expiresAt`,
};

// 实测夹具：按 04 §3.4 的写法配一个门户权限集（父记录授编辑 + 关键字段只读 + 本公司 RLS），一个只读父记录的对照，
// 一个「同环境另一个应用」的 isDefault 权限集（R2），以及写身份行的四个 flow。
const PROBE = defineStack({
  manifest: { id: 'app.objectstack.hotsrm.portal-probe', namespace: 'srm', version: '0.0.0', type: 'module', name: 'portal-probe' },
  objectExtensions: [{ extend: Supplier.name, fields: { portal_position: Field.text({ label: '门户岗位', maxLength: 80 }) } }],
  permissions: [
    {
      name: 'srm_probe_portal',
      label: '门户实测：供应商用户',
      objects: {
        srm_supplier: { allowRead: true, allowCreate: false, allowEdit: true, allowDelete: false },
        srm_supplier_certificate: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: false },
        srm_supplier_contact: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false },
        srm_supplier_bank_account: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false },
      },
      fields: {
        'srm_supplier.name': { readable: true, editable: false },
        'srm_supplier.status': { readable: true, editable: false },
        'srm_supplier.portal_position': { readable: true, editable: false },
        'srm_supplier_certificate.status': { readable: true, editable: false },
        'srm_supplier_certificate.verified': { readable: true, editable: false },
      },
      rowLevelSecurity: [
        { name: 'probe_portal_read', object: Supplier.name, operation: 'select', using: OWN },
        { name: 'probe_portal_write', object: Supplier.name, operation: 'update', using: OWN, check: OWN },
      ],
    },
    {
      // 门户管理员（04 §3.2：联系人、银行账户仅门户管理员可增），按人直接授予
      name: 'srm_probe_portal_admin',
      label: '门户实测：供应商门户管理员',
      objects: {
        srm_supplier_contact: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: false },
        srm_supplier_bank_account: { allowRead: true, allowCreate: true, allowEdit: false, allowDelete: false },
      },
      // 完整银行账号的读写要这项能力（BR-20，银行账号字段的 requiredPermissions）
      systemPermissions: ['srm_view_bank_account_no'],
    },
    {
      name: 'srm_probe_portal_read_parent',
      label: '门户实测：只读父记录',
      objects: {
        srm_supplier: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false },
        srm_supplier_certificate: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: false },
      },
      rowLevelSecurity: [{ name: 'probe_read_parent', object: Supplier.name, operation: 'select', using: OWN }],
    },
    {
      // 委托管理（ADR-0090 D12）：试探非管理员能否经 adminScope 任命门户岗位
      name: 'srm_probe_delegate',
      label: '门户实测：委托任命',
      adminScope: { businessUnit: 'srm_probe_portal_bu', manageAssignments: true, assignablePermissionSets: ['srm_probe_portal'] },
      objects: { sys_user_position: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true } },
    },
    {
      name: 'probe_other_app_default',
      label: '门户实测：另一个应用的默认权限集',
      isDefault: true,
      objects: { srm_category: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false } },
    },
  ],
  positions: [
    { name: 'srm_vendor_probe_a', label: '门户实测 A', permissionSets: ['srm_probe_portal'] },
    { name: 'srm_vendor_probe_b', label: '门户实测 B', permissionSets: ['srm_probe_portal'] },
    { name: 'srm_vendor_probe_c', label: '门户实测 C', permissionSets: ['srm_probe_portal_read_parent'] },
    { name: 'srm_probe_delegate_holder', label: '门户实测：委托任命人', permissionSets: ['srm_probe_delegate'] },
  ],
  flows: [
    writeFlow('srm_probe_assign_system', 'system', 'sys_user_position', assignment, ['userId', 'position', 'orgId']),
    writeFlow('srm_probe_assign_user', 'user', 'sys_user_position', assignment, ['userId', 'position', 'orgId']),
    writeFlow('srm_probe_grant_user', 'user', 'sys_user_permission_set', grant, ['userId', 'permissionSet', 'orgId']),
    writeFlow('srm_probe_invite_system', 'system', 'sys_invitation', invitation, ['email', 'orgId', 'inviterId', 'expiresAt']),
    writeFlow('srm_probe_invite_user', 'user', 'sys_invitation', invitation, ['email', 'orgId', 'inviterId', 'expiresAt']),
  ],
} as Parameters<typeof defineStack>[0]);

type Row = Record<string, any>;
const rowsOf = (body: any): Row[] => body?.records ?? body?.data ?? body?.members ?? (Array.isArray(body) ? body : []);

describe('portal platform checks (v0.6 U1, V1–V5)', () => {
  let stack: VerifyStack;
  let ql: any;
  let orgId = '';
  let seq = 0;
  const token: Record<string, string> = {};
  const uid: Record<string, string> = {};
  const supplier: Record<string, string> = {};
  const certificate: Record<string, string> = {};

  const memberRoles = async (userId: string) =>
    (await ql.find('sys_member', { where: { user_id: userId }, ...SYS })).map((m: Row) => String(m.role));
  // 管理员在成员页发邀请（04 §3.3 第 1 步）→ 对方注册 → 接受邀请。返回接受后的令牌
  const invite = async (who: string, role: 'external' | 'member' | 'admin') => {
    const email = `${who.toLowerCase()}@portal-probe.test`;
    const sent = await stack.apiAs(token.admin, 'POST', '/auth/organization/invite-member', { email, role, organizationId: orgId });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const { id: invitationId } = (await sent.json()) as { id: string };
    const signedUp = await stack.signUp(email, PASSWORD, who);
    uid[who] = String((await stack.contextFor(signedUp)).userId);
    const accepted = await stack.apiAs(signedUp, 'POST', '/auth/organization/accept-invitation', { invitationId });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    // 接受邀请前的会话没有活动组织；重新登录拿到带组织的会话
    token[who] = await stack.signIn(email, PASSWORD);
    return token[who];
  };
  const hold = (who: string, position: string) =>
    stack.seed('sys_user_position', [{ user_id: uid[who], position, organization_id: orgId }]);
  const attachment = async () => {
    const name = `portal-probe-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [
      { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' },
    ]);
    return String(file!.id);
  };
  const certificateDoc = async (supplierId: string) => ({
    supplier: supplierId,
    cert_type: 'iso14001',
    valid_from: '2025-01-01',
    valid_to: '2027-12-31',
    attachment: await attachment(),
  });
  const get = async (who: string, path: string) => {
    const res = await stack.apiAs(token[who], 'GET', path);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const ids = async (who: string, path: string) => {
    const { status, body } = await get(who, path);
    return { status, ids: rowsOf(body).map((r) => String(r.user_id ?? r.userId ?? r.id)) };
  };

  beforeAll(async () => {
    stack = await bootStack(composeStacks([...stacks, PROBE], { manifest: 'preserve' }));
    ql = await stack.kernel.getServiceAsync<any>('objectql');
    token.admin = await stack.signIn();
    const admin = await stack.contextFor(token.admin);
    orgId = String(admin.tenantId);
    uid.admin = String(admin.userId);

    // 两位员工（品类经理、无 SRM 岗位的普通成员），三家供应商的门户用户（A 两人）
    for (const who of ['manager', 'staff']) await invite(who, 'member');
    for (const who of ['supA', 'supA2', 'supB', 'supC']) await invite(who, 'external');
    await hold('manager', 'srm_category_manager');
    await hold('supA', 'srm_vendor_probe_a');
    await hold('supA2', 'srm_vendor_probe_a');
    await hold('supB', 'srm_vendor_probe_b');
    await hold('supC', 'srm_vendor_probe_c');

    for (const key of ['a', 'b', 'c']) {
      const row = await stack.hooks.run(
        Supplier.name,
        'insert',
        { name: `门户实测供应商 ${key}`, credit_code: `91000000MA0PTL${String(++seq).padStart(4, '0')}`, portal_position: `srm_vendor_probe_${key}` },
        { as: token.admin },
      );
      supplier[key] = String(row.id);
      certificate[key] = String((await stack.hooks.run(SupplierCertificate.name, 'insert', await certificateDoc(supplier[key]), { as: token.admin })).id);
      await stack.hooks.run(SupplierContact.name, 'insert', { supplier: supplier[key], name: `联系人 ${key}`, email: `contact-${key}@supplier.test` }, { as: token.admin });
    }

    // 夹具自检：门户用户确实以 external 入组织、持有门户岗位；员工是普通成员
    expect(await memberRoles(uid.supA)).toEqual(['external']);
    expect(await memberRoles(uid.manager)).toEqual(['member']);
    const ctx = (await stack.contextFor(token.supA)) as Row;
    expect(ctx.positions).toEqual(expect.arrayContaining(['org_external', 'srm_vendor_probe_a']));
    expect(ctx.positions).not.toContain('everyone');
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  // 开通前提（04 §3.3）：invite-only 下注册不入组织，接受 external 邀请后以 external 入组织
  describe('invitation path under the invite-only membership policy', () => {
    it('admits a portal user only by accepting the external invitation', async () => {
      const email = 'late-supplier@portal-probe.test';
      const sent = await stack.apiAs(token.admin, 'POST', '/auth/organization/invite-member', { email, role: 'external', organizationId: orgId });
      const { id: invitationId } = (await sent.json()) as { id: string };
      const signedUp = await stack.signUp(email, PASSWORD, 'late');
      const userId = String((await stack.contextFor(signedUp)).userId);
      expect(await memberRoles(userId)).toEqual([]);
      // 还没入组织：用户目录只有自己
      const directory = await stack.apiAs(signedUp, 'GET', '/data/sys_user');
      expect(rowsOf(await directory.json()).map((r) => String(r.id))).toEqual([userId]);
      await stack.apiAs(signedUp, 'POST', '/auth/organization/accept-invitation', { invitationId });
      expect(await memberRoles(userId)).toEqual(['external']);
    });

    it('lets only an organization admin send the invitation', async () => {
      const res = await stack.apiAs(token.manager, 'POST', '/auth/organization/invite-member', {
        email: 'by-manager@portal-probe.test',
        role: 'external',
        organizationId: orgId,
      });
      expect(res.status).toBe(403);
    });
  });

  // V1：external 成员的用户目录只有自己（04 §3.6）
  describe('V1 user directory', () => {
    it('shows an external member only its own user and member rows', async () => {
      for (const who of ['supA', 'supB']) {
        expect(await ids(who, '/data/sys_user'), who).toEqual({ status: 200, ids: [uid[who]] });
        const members = await get(who, '/data/sys_member');
        expect(members.status, who).toBe(200);
        expect(rowsOf(members.body).map((m) => String(m.user_id)), who).toEqual([uid[who]]);
      }
    });

    it('hides an employee and a colleague of the same supplier when addressed by id', async () => {
      expect((await get('supA', `/data/sys_user/${uid.manager}`)).status).toBe(404);
      expect((await get('supA', `/data/sys_user/${uid.supB}`)).status).toBe(404);
      expect((await get('supA', `/data/sys_user/${uid.supA2}`)).status).toBe(404);
    });

    it('answers the organization directory doors with the caller alone', async () => {
      const list = await get('supA', `/auth/organization/list-members?organizationId=${orgId}`);
      expect(list.status).toBe(200);
      expect(list.body.members.map((m: Row) => m.userId)).toEqual([uid.supA]);
      const full = await get('supA', `/auth/organization/get-full-organization?organizationId=${orgId}`);
      expect(full.status).toBe(200);
      expect(full.body.members.map((m: Row) => m.userId)).toEqual([uid.supA]);
      expect((full.body.invitations ?? []).filter((i: Row) => i.email !== 'supa@portal-probe.test')).toEqual([]);
      const invitations = await get('supA', `/auth/organization/list-invitations?organizationId=${orgId}`);
      expect(invitations.status).toBe(200);
      expect(rowsOf(invitations.body).filter((i) => i.email !== 'supa@portal-probe.test')).toEqual([]);
    });

    it('CONTROL: an employee still reads the whole directory', async () => {
      const { ids: seen } = await ids('staff', '/data/sys_user');
      expect(seen).toEqual(expect.arrayContaining([uid.admin, uid.manager, uid.supA, uid.supB]));
    });
  });

  // V2：flow 写岗位任命与权限集授予（04 §3.3 第 3 步）
  describe('V2 position assignment from a flow', () => {
    const assign = (userId: string, position: string) => ({ userId, position, orgId });

    it('refuses the assignment from a flow running as system (objectstack#25251)', async () => {
      await expect(
        stack.flows.run('srm_probe_assign_system', assign(uid.supB, 'srm_vendor_probe_c'), { as: token.admin }),
      ).rejects.toMatchObject({ code: 'FLOW_FAILED', message: expect.stringContaining("runAs: 'system'") });
    });

    it('writes the assignment from a runAs user flow started by an organization admin', async () => {
      const run = await stack.flows.run('srm_probe_assign_user', assign(uid.supB, 'srm_vendor_probe_c'), { as: token.admin });
      expect(run.success, JSON.stringify(run)).toBe(true);
      const held = await ql.find('sys_user_position', { where: { user_id: uid.supB, position: 'srm_vendor_probe_c' }, ...SYS });
      expect(held).toHaveLength(1);
      await ql.delete('sys_user_position', { where: { id: held[0].id }, ...SYS });
    });

    it('writes it for an organization admin who is not a platform admin as well', async () => {
      const orgAdmin = await invite('orgAdmin', 'admin');
      expect(await memberRoles(uid.orgAdmin)).toEqual(['admin']);
      const run = await stack.flows.run('srm_probe_assign_user', assign(uid.supB, 'srm_vendor_probe_c'), { as: orgAdmin });
      expect(run.success, JSON.stringify(run)).toBe(true);
      const held = await ql.find('sys_user_position', { where: { user_id: uid.supB, position: 'srm_vendor_probe_c' }, ...SYS });
      expect(held).toHaveLength(1);
      await ql.delete('sys_user_position', { where: { id: held[0].id }, ...SYS });
    });

    it('refuses the same flow started by a category manager (srm_supplier_admin is not an administrator)', async () => {
      await expect(
        stack.flows.run('srm_probe_assign_user', assign(uid.supB, 'srm_vendor_probe_c'), { as: token.manager }),
      ).rejects.toMatchObject({ code: 'FLOW_FAILED', message: expect.stringContaining('ADR-0090 D12') });
    });

    it('cannot delegate the assignment of an external: a delegated scope needs a business unit, which an external has none of', async () => {
      const [unit] = await ql.find('sys_business_unit', { where: { name: 'srm_probe_portal_bu' }, ...SYS });
      const bu = unit ?? (await ql.insert('sys_business_unit', { name: 'srm_probe_portal_bu', organization_id: orgId }, SYS));
      await stack.seed('sys_user_position', [{ user_id: uid.manager, position: 'srm_probe_delegate_holder', organization_id: orgId, business_unit_id: String(bu.id) }]);
      const delegate = await stack.contextFor(token.manager);
      expect((delegate as Row).positions).toContain('srm_probe_delegate_holder');
      // 不带业务单元锚点：委托任命一律拒绝
      const doc = { user_id: uid.supB, position: 'srm_vendor_probe_a', organization_id: orgId };
      // 不带业务单元锚点：委托任命一律拒绝
      await expect(ql.insert('sys_user_position', doc, { context: delegate })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('no business_unit_id anchor'),
      });
      // 带锚点：外部成员不能放进业务单元（04 §3.3）
      await expect(ql.insert('sys_user_position', { ...doc, business_unit_id: String(bu.id) }, { context: delegate })).rejects.toThrow(
        /external member is not placed in the organization's business units/,
      );
    });

    it('grants the portal admin permission set to an external user from a runAs user flow started by an organization admin', async () => {
      const run = await stack.flows.run(
        'srm_probe_grant_user',
        { userId: uid.supA, permissionSet: 'srm_probe_portal_admin', orgId },
        { as: token.admin },
      );
      expect(run.success, JSON.stringify(run)).toBe(true);
      expect(((await stack.contextFor(token.supA)) as Row).permissions).toContain('srm_probe_portal_admin');
    });
  });

  // V3：flow 发组织邀请
  describe('V3 invitation from a flow', () => {
    const params = (email: string, inviterId: string) => ({
      email,
      orgId,
      inviterId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    it('refuses the invitation from a flow running as system (objectstack#25251)', async () => {
      await expect(
        stack.flows.run('srm_probe_invite_system', params('flow-system@portal-probe.test', uid.admin), { as: token.admin }),
      ).rejects.toMatchObject({ code: 'FLOW_FAILED', message: expect.stringContaining("runAs: 'system'") });
    });

    it('refuses it from a runAs user flow too, even for an organization admin: invitations are written only by the auth endpoints (ADR-0092)', async () => {
      await expect(
        stack.flows.run('srm_probe_invite_user', params('flow-user@portal-probe.test', uid.admin), { as: token.admin }),
      ).rejects.toMatchObject({ code: 'FLOW_FAILED', message: expect.stringContaining('ADR-0092') });
      const written = await ql.find('sys_invitation', { where: { email: 'flow-user@portal-probe.test' }, ...SYS });
      expect(written).toEqual([]);
    });
  });

  // V4：controlled_by_parent 子记录的写入 = 父记录授编辑 + 字段级只读（04 §3.2、§3.4）
  describe('V4 writes to controlled_by_parent records', () => {
    const asA = () => ({ as: token.supA });

    it('reads only its own supplier and that supplier’s certificates and contacts', async () => {
      expect((await ids('supA', `/data/${Supplier.name}`)).ids).toEqual([supplier.a]);
      expect((await ids('supA', `/data/${SupplierCertificate.name}`)).ids).toEqual([certificate.a]);
      expect((await ids('supA', `/data/${SupplierContact.name}`)).ids).toHaveLength(1);
      expect((await get('supA', `/data/${Supplier.name}/${supplier.b}`)).status).toBe(404);
      expect((await get('supA', `/data/${SupplierCertificate.name}/${certificate.b}`)).status).toBe(404);
    });

    it('edits an open field of its own supplier, and nothing of another supplier', async () => {
      await stack.hooks.run(Supplier.name, 'update', { id: supplier.a, website: 'https://a.supplier.test' }, asA());
      expect((await stack.rows(Supplier.name, { id: supplier.a }))[0]!.website).toBe('https://a.supplier.test');
      await expect(stack.hooks.run(Supplier.name, 'update', { id: supplier.b, website: 'https://x.test' }, asA())).rejects.toMatchObject({
        code: 'RECORD_NOT_FOUND',
      });
    });

    it('refuses a write to a read-only field of its own supplier, whole, at the engine and at REST', async () => {
      for (const field of ['name', 'status', 'portal_position']) {
        await expect(
          stack.hooks.run(Supplier.name, 'update', { id: supplier.a, [field]: field === 'portal_position' ? 'srm_vendor_probe_b' : 'x' }, asA()),
          field,
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      }
      const res = await stack.apiAs(token.supA, 'PATCH', `/data/${Supplier.name}/${supplier.a}`, { name: '改名', website: 'https://rest.test' });
      expect(res.status).toBe(403);
      expect((await stack.rows(Supplier.name, { id: supplier.a }))[0]).toMatchObject({
        name: '门户实测供应商 a',
        website: 'https://a.supplier.test',
        portal_position: 'srm_vendor_probe_a',
      });
    });

    it('adds a certificate to its own supplier, at the engine and at REST, and not to another supplier', async () => {
      const own = await stack.hooks.run(SupplierCertificate.name, 'insert', await certificateDoc(supplier.a), asA());
      expect(own.supplier).toBe(supplier.a);
      const rest = await stack.apiAs(token.supA, 'POST', `/data/${SupplierCertificate.name}`, await certificateDoc(supplier.a));
      expect(rest.status, await rest.clone().text()).toBeLessThan(300);
      await expect(stack.hooks.run(SupplierCertificate.name, 'insert', await certificateDoc(supplier.b), asA())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    });

    it('edits a certificate an employee entered, and a colleague of the same supplier can too', async () => {
      await stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.a, valid_to: '2028-06-30' }, asA());
      await stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.a, valid_to: '2028-12-31' }, { as: token.supA2 });
      expect((await stack.rows(SupplierCertificate.name, { id: certificate.a }))[0]!.valid_to).toBe('2028-12-31');
    });

    it('refuses the certificate’s flow-owned fields, a move to another supplier, a delete, and another supplier’s certificate', async () => {
      await expect(
        stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.a, status: 'valid', verified: true }, asA()),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(
        stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.a, supplier: supplier.b }, asA()),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(stack.hooks.run(SupplierCertificate.name, 'delete', { id: certificate.a }, asA())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(
        stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.b, valid_to: '2030-01-01' }, asA()),
      ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
      expect((await stack.rows(SupplierCertificate.name, { id: certificate.a }))[0]).toMatchObject({ supplier: supplier.a, verified: false });
    });

    it('needs edit on the parent: with read-only access to its supplier it can neither add nor edit a certificate', async () => {
      await expect(
        stack.hooks.run(SupplierCertificate.name, 'insert', await certificateDoc(supplier.c), { as: token.supC }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('master') });
      await expect(
        stack.hooks.run(SupplierCertificate.name, 'update', { id: certificate.c, valid_to: '2030-01-01' }, { as: token.supC }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('master') });
    });

    it('lets only the portal admin add contacts and bank accounts', async () => {
      // supA 在 V2 已直接获授门户管理员权限集；supA2 没有
      const bank = { supplier: supplier.a, bank_name: '示例银行', account_name: '门户实测供应商 a', account_no: '6222000011112222' };
      const contact = { supplier: supplier.a, name: '新联系人', email: 'new-contact@supplier.test' };
      await expect(stack.hooks.run(SupplierContact.name, 'insert', contact, { as: token.supA2 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(stack.hooks.run(SupplierBankAccount.name, 'insert', bank, { as: token.supA2 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      const grants = await ql.find('sys_user_permission_set', { where: { user_id: uid.supA, permission_set: 'srm_probe_portal_admin' }, ...SYS });
      expect(grants, 'V2 grant must run first').toHaveLength(1);
      expect((await stack.hooks.run(SupplierContact.name, 'insert', contact, asA())).supplier).toBe(supplier.a);
      const account = await stack.hooks.run(SupplierBankAccount.name, 'insert', bank, asA());
      expect(account).toMatchObject({ supplier: supplier.a, status: 'pending_verify' });
      await expect(
        stack.hooks.run(SupplierBankAccount.name, 'insert', { ...bank, supplier: supplier.b }, asA()),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });

  // V5：同环境其他应用的 isDefault 权限集到不了 external 成员（R2）
  describe('V5 default permission sets of other apps', () => {
    it('reaches every employee but no external member', async () => {
      expect((await stack.contextFor(token.staff) as Row).permissions).toContain('probe_other_app_default');
      expect((await get('staff', '/data/srm_category')).status).toBe(200);
      for (const who of ['supA', 'supB', 'supC']) {
        const ctx = (await stack.contextFor(token[who])) as Row;
        expect(ctx.permissions, who).not.toContain('probe_other_app_default');
        expect(ctx.permissions, who).not.toContain('member_default');
        expect((await get(who, '/data/srm_category')).status, who).toBe(403);
      }
    });
  });
});

// 对照：成员策略为 auto（单组织部署的默认）时，注册即以普通成员入组织，接受 external 邀请前能读全组织用户目录。
// 所以门户上线的环境必须设 invite-only（04 §3.3）。
describe('membership policy auto (control)', () => {
  let stack: VerifyStack;

  beforeAll(async () => {
    process.env.OS_AUTH_MEMBERSHIP_POLICY = 'auto';
    stack = await bootStack(composeStacks([...stacks, PROBE], { manifest: 'preserve' }));
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    process.env.OS_AUTH_MEMBERSHIP_POLICY = 'invite-only';
  });

  it('binds an invited supplier as a plain member at sign-up, before the invitation is accepted', async () => {
    const admin = await stack.signIn();
    const orgId = String((await stack.contextFor(admin)).tenantId);
    const email = 'auto-supplier@portal-probe.test';
    const sent = await stack.apiAs(admin, 'POST', '/auth/organization/invite-member', { email, role: 'external', organizationId: orgId });
    const { id: invitationId } = (await sent.json()) as { id: string };
    const signedUp = await stack.signUp(email, PASSWORD, 'auto');
    const res = await stack.apiAs(signedUp, 'GET', '/data/sys_user');
    expect(res.status).toBe(200);
    expect(rowsOf(await res.json()).length).toBeGreaterThan(1);
    await stack.apiAs(signedUp, 'POST', '/auth/organization/accept-invitation', { invitationId });
    const userId = String((await stack.contextFor(signedUp)).userId);
    const ql = await stack.kernel.getServiceAsync<any>('objectql');
    expect((await ql.find('sys_member', { where: { user_id: userId }, ...SYS })).map((m: Row) => m.role)).toEqual(['external']);
  });
});
