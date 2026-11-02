import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import { cel, composeStacks, defineStack } from '@objectstack/spec';
import { stacks } from '../objectstack.composition';

// v0.6 U3（#79）：门户邀请 → 组织邀请（external）→ 注册并接受 → 开通门户 → 提交准入申请 → 只看到本公司；
// 回收（准入未通过、联系人停用、淘汰）后看不到；邀请过期。设计见 04 §3.3、03 §3，制度见 GL-10 6.2–6.6。
// 门户用户沿用 U1（test/portal-platform.test.ts）的真实路径：成员策略 invite-only，组织管理员在成员页按邮箱邀请为
// external，对方注册、接受邀请后重新登录。
process.env.OS_AUTH_MEMBERSHIP_POLICY = 'invite-only';

const PASSWORD = 'Portal!Invite123';
type Row = Record<string, any>;

// 平台行为探针（07 §6.3 PF19）：runAs: 'user' 的 flow 写字段级只读的 portal_user，数据层剔除该字段、节点只给警告，
// 运行照样成功。所以「开通门户」把名册写入交给系统身份的子 flow；平台行为一变本探针就会失败，届时复核 07 §6.3
const PROBE = defineStack({
  manifest: { id: 'app.objectstack.hotsrm.invitation-probe', namespace: 'srm', version: '0.0.0', type: 'module', name: 'invitation-probe' },
  flows: [
    {
      name: 'srm_probe_user_writes_roster',
      label: 'srm_probe_user_writes_roster',
      type: 'screen',
      status: 'active',
      runAs: 'user',
      variables: ['contactId', 'userId'].map((name) => ({ name, type: 'text', isInput: true, isOutput: false })),
      nodes: [
        { id: 'start', type: 'start', label: 'start' },
        {
          id: 'write',
          type: 'update_record',
          label: 'write',
          config: { objectName: 'srm_supplier_contact', filter: { id: cel`contactId` }, fields: { portal_user: cel`userId` } },
        },
        { id: 'end', type: 'end', label: 'end' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'write', type: 'default' },
        { id: 'e2', source: 'write', target: 'end', type: 'default' },
      ],
    },
  ],
} as Parameters<typeof defineStack>[0]);

describe('portal invitation and opening (v0.6 U3)', () => {
  let stack: VerifyStack;
  let ql: any;
  let orgId = '';
  let seq = 0;
  const token: Record<string, string> = {};
  const uid: Record<string, string> = {};
  let category = '';

  const SYS = { context: { isSystem: true } };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0] as Row;
  const system = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as Row;
  const signUp = async (who: string) => {
    const email = `${who.toLowerCase()}@invitation.test`;
    const signed = await stack.signUp(email, PASSWORD, who);
    uid[who] = String((await stack.contextFor(signed)).userId);
    return { email, signed };
  };
  // 组织管理员在成员页按邮箱发邀请 → 对方注册 → 接受 → 重新登录拿到带组织的会话（04 §3.3 第 1 步）
  const join = async (who: string, role: 'external' | 'member' | 'admin') => {
    const email = `${who.toLowerCase()}@invitation.test`;
    const sent = await stack.apiAs(token.owner, 'POST', '/auth/organization/invite-member', { email, role, organizationId: orgId });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const { id: invitationId } = (await sent.json()) as { id: string };
    const { signed } = await signUp(who);
    const accepted = await stack.apiAs(signed, 'POST', '/auth/organization/accept-invitation', { invitationId });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    token[who] = await stack.signIn(email, PASSWORD);
    return token[who];
  };
  const hold = (who: string, position: string) => stack.seed('sys_user_position', [{ user_id: uid[who], position, organization_id: orgId }]);
  const positionsOf = async (who: string) =>
    (await ql.find('sys_user_position', { where: { user_id: uid[who] }, ...SYS })).map((p: Row) => String(p.position)).sort();

  const attachment = async () => {
    const name = `invitation-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [{ key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' }]);
    return String(file!.id);
  };
  // 品类经理先登记潜在供应商与联系人（总监裁定 2026-11-02：没有供应商档案就无法隔离）
  const supplierWithContact = async (label: string, extra: Row = {}) => {
    const n = ++seq;
    // 存量导入的合格供应商只有系统管理员的导入能建，这里以系统身份建；潜在供应商由品类经理登记
    const doc = { name: `示例门户邀请${label}有限公司 ${n}`, credit_code: `91000000MA0INV${String(n).padStart(4, '0')}`, ...extra };
    const supplier = extra.legacy_imported
      ? await stack.hooks.run('srm_supplier', 'insert', doc, { system: true })
      : await stack.hooks.run('srm_supplier', 'insert', doc, { as: token.manager });
    const contact = await stack.hooks.run(
      'srm_supplier_contact',
      'insert',
      { supplier: supplier.id, name: `联系人 ${n}`, email: `contact-${n}@supplier.test` },
      { as: token.manager },
    );
    return { supplier: String(supplier.id), contact: String(contact.id) };
  };
  const invite = async (target: { supplier: string; contact: string }, extra: Row = {}) =>
    (await stack.hooks.run('srm_supplier_invitation', 'insert', { supplier: target.supplier, contact: target.contact, ...extra }, { as: token.manager })) as Row;

  // 从门户邀请上的按钮启动「开通门户」，在选账号的屏上提交
  const open = async (as: string, invitationId: string, account: string) => {
    const started = (await stack.actions.run('srm_supplier_invitation', 'srm_portal_enable', { as, recordId: invitationId })) as Row;
    if (started.status !== 'paused') return started;
    return (await stack.flows.resume({ flowName: 'srm_portal_enable', runId: started.runId }, { portal_account: account }, { as })) as Row;
  };
  const submitApplication = async (as: string, supplierId: string) => {
    const started = (await stack.actions.run('srm_supplier', 'srm_application_submit', { as, recordId: supplierId })) as Row;
    if (started.status !== 'paused') return started;
    return (await stack.flows.resume({ flowName: 'srm_application_submit', runId: started.runId }, {}, { as })) as Row;
  };
  const refused = (run: Row, why: RegExp) => {
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'refused' });
    expect(String(run.refusalMessage), JSON.stringify(run)).toMatch(why);
  };
  const visibleSuppliers = async (who: string) => {
    const res = await stack.apiAs(token[who], 'GET', '/data/srm_supplier');
    const body = (await res.json().catch(() => ({}))) as { records?: Row[] };
    return { status: res.status, ids: (body.records ?? []).map((r) => String(r.id)) };
  };

  let X: { supplier: string; contact: string };
  let invitationX: Row;

  beforeAll(async () => {
    stack = await bootStack(composeStacks([...stacks, PROBE], { manifest: 'preserve' }));
    ql = await stack.kernel.getServiceAsync<any>('objectql');
    token.owner = await stack.signIn();
    const owner = await stack.contextFor(token.owner);
    orgId = String(owner.tenantId);
    uid.owner = String(owner.userId);

    // 组织管理员兼 SRM 系统管理员（04 §3.3）；品类经理；不是管理员的普通员工
    await join('orgAdmin', 'admin');
    await hold('orgAdmin', 'srm_admin');
    await join('manager', 'member');
    await hold('manager', 'srm_category_manager');
    await join('staff', 'member');
    await hold('staff', 'srm_buyer');
    category = String((await system('srm_category', { code: 'INV1', name: '示例门户邀请品类' })).id);
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  describe('a category manager raises the request', () => {
    it('creates an admission invitation for a potential supplier; the flow fills the email and the deadline and tells the org admins', async () => {
      X = await supplierWithContact('甲');
      invitationX = await invite(X, { categories: [category] });
      const saved = await row('srm_supplier_invitation', String(invitationX.id));
      expect(saved).toMatchObject({ status: 'sent', contact_email: expect.stringMatching(/@supplier\.test$/) });
      expect(String(saved.expires_on) > new Date().toISOString().slice(0, 10)).toBe(true);
      await expect
        .poll(async () => (await stack.rows('sys_notification', { source_id: String(invitationX.id) })).length)
        .toBe(1);
    });

    it('needs the applied categories for a potential supplier, and refuses them for a qualified one', async () => {
      const P = await supplierWithContact('乙');
      await expect(invite(P)).rejects.toThrow(/申请品类|applied categories/i);
      const Q = await supplierWithContact('丙', { legacy_imported: true });
      await expect(invite(Q, { categories: [category] })).rejects.toThrow(/申请品类|applied categories/i);
      // 只开通门户的邀请（已合格供应商）不填品类
      expect((await invite(Q)).status).toBe('sent');
    });

    it('refuses a blacklisted supplier, a contact of another supplier, and a portal admin grant without the authorization letter', async () => {
      const B = await supplierWithContact('丁', { legacy_imported: true });
      await stack.hooks.run('srm_supplier', 'update', { id: B.supplier, status: 'blacklisted' }, { system: true });
      await expect(invite(B)).rejects.toThrow(/黑名单|blacklisted/);
      const C = await supplierWithContact('戊', { legacy_imported: true });
      await expect(invite({ supplier: C.supplier, contact: X.contact })).rejects.toThrow(/联系人必须属于|must belong/);
      await expect(invite(C, { portal_admin: true })).rejects.toThrow();
      expect((await invite(C, { portal_admin: true, admin_authorization: await attachment() })).portal_admin).toBe(true);
    });

    it('does not let the category manager set the status or the portal account, or move the invitation to another contact', async () => {
      const other = await supplierWithContact('乙二');
      await stack.hooks.run('srm_supplier_invitation', 'update', { id: invitationX.id, status: 'accepted', portal_user: uid.manager }, { as: token.manager }).catch(() => null);
      await stack.hooks.run('srm_supplier_invitation', 'update', { id: invitationX.id, supplier: other.supplier, contact: other.contact }, { as: token.manager }).catch(() => null);
      expect(await row('srm_supplier_invitation', String(invitationX.id))).toMatchObject({ supplier: X.supplier, contact: X.contact });
      expect(await row('srm_supplier_invitation', String(invitationX.id))).toMatchObject({ status: 'sent' });
      expect((await row('srm_supplier_invitation', String(invitationX.id))).portal_user ?? null).toBeNull();
    });
  });

  describe('the organization admin opens the portal', () => {
    it('refuses a category manager and an employee who is not an organization admin', async () => {
      await join('supX', 'external');
      for (const who of ['manager', 'staff']) {
        refused(await open(token[who], String(invitationX.id), uid.supX), /organization administrator/);
      }
      expect((await row('srm_supplier_contact', X.contact)).portal_user ?? null).toBeNull();
    });

    it('refuses a user who has not joined, and an internal member', async () => {
      await signUp('notJoined');
      refused(await open(token.orgAdmin, String(invitationX.id), uid.notJoined), /has not joined/);
      refused(await open(token.orgAdmin, String(invitationX.id), uid.staff), /external member/);
      expect(await positionsOf('staff')).toEqual(['srm_buyer']);
    });

    it('assigns the static portal position, writes the roster and marks the invitation opened', async () => {
      expect(await visibleSuppliers('supX')).toMatchObject({ ids: [] });
      const run = await open(token.orgAdmin, String(invitationX.id), uid.supX);
      expect(run.success, JSON.stringify(run)).toBe(true);
      expect(run.status, JSON.stringify(run)).not.toBe('refused');
      expect(await positionsOf('supX')).toEqual(['srm_portal_user']);
      expect((await row('srm_supplier_contact', X.contact)).portal_user).toBe(uid.supX);
      expect(await row('srm_supplier_invitation', String(invitationX.id))).toMatchObject({
        status: 'accepted',
        portal_user: uid.supX,
        enabled_by: uid.orgAdmin,
      });
      // 下一个请求起只看到本公司
      expect(await visibleSuppliers('supX')).toEqual({ status: 200, ids: [X.supplier] });
    });

    it('opens a portal admin only when the invitation grants it', async () => {
      const A = await supplierWithContact('己', { legacy_imported: true });
      const inv = await invite(A, { portal_admin: true, admin_authorization: await attachment() });
      await join('supA', 'external');
      expect((await open(token.orgAdmin, String(inv.id), uid.supA)).success).toBe(true);
      expect(await positionsOf('supA')).toEqual(['srm_portal_admin', 'srm_portal_user']);
      expect(await visibleSuppliers('supA')).toEqual({ status: 200, ids: [A.supplier] });
    });

    it('keeps one account on one contact: refuses to register an opened user on another supplier', async () => {
      const Y = await supplierWithContact('庚', { legacy_imported: true });
      const inv = await invite(Y);
      refused(await open(token.orgAdmin, String(inv.id), uid.supX), /another contact/);
      expect((await row('srm_supplier_contact', Y.contact)).portal_user ?? null).toBeNull();
      expect(await visibleSuppliers('supX')).toEqual({ status: 200, ids: [X.supplier] });
      // 已开通的邀请不能再开通
      refused(await open(token.orgAdmin, String(invitationX.id), uid.supX), /Only a Sent invitation/);
    });

    it('writes the roster only through the opening flow: the system sub-flow cannot be started directly', async () => {
      const Z = await supplierWithContact('辛', { legacy_imported: true });
      for (const who of ['owner', 'orgAdmin', 'manager']) {
        await expect(
          stack.flows.run('srm_portal_roster_write', { contactId: Z.contact, userId: uid.staff, invitationId: '', operatorId: uid[who] }, { as: token[who] }),
          who,
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      }
      expect((await row('srm_supplier_contact', Z.contact)).portal_user ?? null).toBeNull();
    });

    // PF19：平台行为变了这里会失败，届时复核「开通门户」的子 flow 写法（07 §6.3）
    it('PLATFORM PROBE (PF19): a runAs user flow writing the read-only portal_user succeeds without writing it', async () => {
      const W = await supplierWithContact('壬', { legacy_imported: true });
      const run = await stack.flows.run('srm_probe_user_writes_roster', { contactId: W.contact, userId: uid.staff }, { as: token.owner });
      expect(run.success).toBe(true);
      expect((await row('srm_supplier_contact', W.contact)).portal_user ?? null).toBeNull();
    });
  });

  describe('the invited supplier applies in the portal', () => {
    // 按钮只给有门户访问能力的人；直接触发时 flow 只认调用者自己的名册行
    it('refuses an employee: the supplier comes from the caller’s own roster row', async () => {
      await expect(submitApplication(token.manager, X.supplier)).rejects.toThrow(/srm_portal_access/);
      refused((await stack.flows.run('srm_application_submit', { recordId: X.supplier }, { as: token.manager })) as Row, /submitted by invited suppliers/);
    });

    // 直接触发 flow（不经记录页按钮）也一样：系统身份的 flow 只认调用者在该供应商上的名册行
    it('refuses a portal user of another supplier, from the record button and from a direct trigger', async () => {
      // 按钮入口：别家的供应商对门户不可见，平台答「不存在」或 flow 拒绝
      const button = (await submitApplication(token.supA, X.supplier).catch((e) => ({ status: 'error', error: e }))) as Row;
      expect(['error', 'refused'], JSON.stringify(button)).toContain(button.status);
      refused((await stack.flows.run('srm_application_submit', { recordId: X.supplier }, { as: token.supA })) as Row, /submitted by invited suppliers/);
      expect(await stack.rows('srm_supplier_application', { supplier: X.supplier })).toHaveLength(0);
      expect((await row('srm_supplier_invitation', String(invitationX.id))).application ?? null).toBeNull();
    });

    it('submits the application with the invitation’s categories, source invited, and links it back to the invitation', async () => {
      const run = await submitApplication(token.supX, X.supplier);
      expect(run.success, JSON.stringify(run)).toBe(true);
      const inv = await row('srm_supplier_invitation', String(invitationX.id));
      expect(inv.application).toBeTruthy();
      const app = await row('srm_supplier_application', String(inv.application));
      expect(app).toMatchObject({ supplier: X.supplier, source: 'invited', duplicate_check: 'pass' });
      expect(app.applied_categories).toEqual([category]);
      // 受理照常：供应商进入准入中，门户看得到自己的申请
      expect((await row('srm_supplier', X.supplier)).status).toBe('qualifying');
      const res = await stack.apiAs(token.supX, 'GET', '/data/srm_supplier_application');
      expect(((await res.json()) as { records: Row[] }).records.map((r) => String(r.id))).toEqual([String(inv.application)]);
    });

    it('tells the inviting category manager, who handles the application the portal user owns and returns it only with a reason', async () => {
      const appId = String((await row('srm_supplier_invitation', String(invitationX.id))).application);
      // 申请由系统身份代建、属于提交的门户用户；邀请人收到受理待办
      await expect
        .poll(async () => {
          for (const note of await stack.rows('sys_notification', { source_id: appId })) {
            const receipts = await stack.rows('sys_notification_receipt', { notification_id: note.id });
            if (receipts.some((r) => String(r.user_id ?? r.recipient_id ?? '') === uid.manager)) return true;
          }
          return false;
        })
        .toBe(true);
      // 品类经理不是申请的拥有人，仍能退回补充（共享规则），但要写退回意见
      await expect(
        stack.hooks.run('srm_supplier_application', 'update', { id: appId, status: 'returned' }, { as: token.manager }),
      ).rejects.toThrow(/supplement|退回意见/);
      await stack.hooks.run('srm_supplier_application', 'update', { id: appId, status: 'returned', return_reason: '请补传 ISO 9001 证书' }, { as: token.manager });
      // 门户看得到退回意见
      const res = await stack.apiAs(token.supX, 'GET', `/data/srm_supplier_application/${appId}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain('请补传 ISO 9001 证书');
      // 门户补充后重新提交：回到资料审核（后面的用例从这里接着走），通知退回它的品类经理，不通知门户用户自己
      const before = (await stack.rows('sys_notification', { source_id: appId })).map((n) => String(n.id));
      const started = (await stack.actions.run('srm_supplier_application', 'srm_application_resubmit', { as: token.supX, recordId: appId })) as Row;
      const run = (await stack.flows.resume({ flowName: 'srm_application_resubmit', runId: started.runId }, { note: '已补传' }, { as: token.supX })) as Row;
      expect(run.success, JSON.stringify(run)).toBe(true);
      expect((await row('srm_supplier_application', appId)).status).toBe('doc_review');
      await expect
        .poll(async () => {
          const fresh = (await stack.rows('sys_notification', { source_id: appId })).filter((n) => !before.includes(String(n.id)));
          const receipts = (await Promise.all(fresh.map((n) => stack.rows('sys_notification_receipt', { notification_id: n.id })))).flat();
          return receipts.map((r) => String(r.user_id ?? r.recipient_id ?? ''));
        })
        .toEqual([uid.manager]);
    });

    it('submits once per invitation', async () => {
      refused(await submitApplication(token.supX, X.supplier), /No admission invitation is waiting/);
      expect(await stack.rows('srm_supplier_application', { supplier: X.supplier })).toHaveLength(1);
    });

    it('does not let the portal see invitations', async () => {
      const res = await stack.apiAs(token.supX, 'GET', '/data/srm_supplier_invitation');
      const ids = res.status === 200 ? ((await res.json()) as { records: Row[] }).records : [];
      expect(ids).toEqual([]);
    });
  });

  describe('revocation', () => {
    it('revokes the portal when the admission is rejected and the supplier returns to potential (03 §3 step 8)', async () => {
      const [app] = await stack.rows('srm_supplier_application', { supplier: X.supplier });
      const before = (await stack.rows('sys_notification', { source_id: String(app!.id) })).length;
      await stack.hooks.run('srm_supplier_application', 'update', { id: app!.id, status: 'rejected', reject_reason: '示例未通过' }, { system: true });
      expect((await row('srm_supplier', X.supplier)).status).toBe('potential');
      expect((await row('srm_supplier_contact', X.contact)).portal_user ?? null).toBeNull();
      expect((await row('srm_supplier_invitation', String(invitationX.id))).status).toBe('revoked');
      expect(await visibleSuppliers('supX')).toMatchObject({ ids: [] });
      await expect.poll(async () => (await stack.rows('sys_notification', { source_id: String(app!.id) })).length).toBeGreaterThan(before);
    });

    it('clears the roster when a contact is deactivated, so reactivating it does not bring the portal back', async () => {
      const D = await supplierWithContact('癸', { legacy_imported: true });
      const inv = await invite(D);
      await join('supD', 'external');
      expect((await open(token.orgAdmin, String(inv.id), uid.supD)).success).toBe(true);
      expect(await visibleSuppliers('supD')).toEqual({ status: 200, ids: [D.supplier] });
      await stack.hooks.run('srm_supplier_contact', 'update', { id: D.contact, active: false }, { as: token.manager });
      expect(await visibleSuppliers('supD')).toMatchObject({ ids: [] });
      expect((await row('srm_supplier_contact', D.contact)).portal_user ?? null).toBeNull();
      expect((await row('srm_supplier_invitation', String(inv.id))).status).toBe('revoked');
      await stack.hooks.run('srm_supplier_contact', 'update', { id: D.contact, active: true }, { as: token.manager });
      expect(await visibleSuppliers('supD')).toMatchObject({ ids: [] });
    });

    it('revokes open invitations and the roster when a supplier is eliminated', async () => {
      const E = await supplierWithContact('子', { legacy_imported: true });
      const opened = await invite(E);
      await join('supE', 'external');
      expect((await open(token.orgAdmin, String(opened.id), uid.supE)).success).toBe(true);
      const second = await stack.hooks.run('srm_supplier_contact', 'insert', { supplier: E.supplier, name: '第二联系人', email: 'second@supplier.test' }, { as: token.manager });
      const waiting = await invite({ supplier: E.supplier, contact: String(second.id) });
      const [disposition] = await stack.seed('srm_supplier_disposition', [
        { supplier: E.supplier, action: 'eliminate', scope: 'all', reason: '示例淘汰', status: 'in_review' },
      ]);
      const run = await stack.flows.run('srm_disposition_apply', { recordId: String(disposition!.id) }, { system: true });
      expect(run.success, JSON.stringify(run)).toBe(true);
      expect(await visibleSuppliers('supE')).toMatchObject({ ids: [] });
      expect((await row('srm_supplier_invitation', String(opened.id))).status).toBe('revoked');
      expect((await row('srm_supplier_invitation', String(waiting.id))).status).toBe('revoked');
      await expect.poll(async () => (await stack.rows('sys_notification', { source_id: String(disposition!.id) })).length).toBeGreaterThan(0);
    });
  });

  describe('expiry', () => {
    it('expires a sent invitation past its deadline, once, and leaves opened ones alone', async () => {
      const F = await supplierWithContact('丑', { legacy_imported: true });
      const late = await invite(F);
      await stack.hooks.run('srm_supplier_invitation', 'update', { id: late.id, expires_on: '2026-01-01' }, { system: true });
      const fresh = await invite({ supplier: F.supplier, contact: String((await stack.hooks.run('srm_supplier_contact', 'insert', { supplier: F.supplier, name: '另一位', email: 'another@supplier.test' }, { as: token.manager })).id) });
      for (let i = 0; i < 2; i++) {
        const run = await stack.flows.run('srm_invitation_expire_sweep', {}, { system: true });
        expect(run.success, JSON.stringify(run)).toBe(true);
      }
      expect((await row('srm_supplier_invitation', String(late.id))).status).toBe('expired');
      expect((await row('srm_supplier_invitation', String(fresh.id))).status).toBe('sent');
      refused(await open(token.orgAdmin, String(late.id), uid.staff), /Only a Sent invitation/);
    });
  });
});
