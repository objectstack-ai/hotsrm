import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import { triggerFlow } from './support/flows';
import { uploadedFile } from './support/files';
import config from '../objectstack.config';

// v0.6 U4 门户自助维护（03 §3 第 4 步、§5、§11，04 §3.2、§4.2）：门户补证书 → SQE 核验后资质异常解除；门户管理员经
// 「提交变更申请」提交关键信息变更 → 审批写回；被退回的变更单门户改完重新提交；准入申请退回补充后门户重新提交；
// 门户管理员新建银行账户 → 应付会计核验。门户用户的准备沿用 portal-isolation.test.ts（external + 门户岗位 + 名册）。
// 测试数据全部在这里生成（示例公司名、示例银行），不依赖外部样本。

type Row = Record<string, any>;
type Person = { token: string; id: string };

describe('portal self-service (v0.6 U4)', () => {
  let stack: VerifyStack;
  let admin: string;
  let seq = 0;
  let org: Record<string, string> = {};

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const sys = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as Row;
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const scan = (as?: string) => uploadedFile(stack, as, 'self-service-scan');
  const assign = (userId: string, position: string) => stack.seed('sys_user_position', [{ user_id: userId, position, ...org }]);
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`ss-${positions.join('-')}-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    for (const position of positions) await assign(id, position);
    return { token, id };
  };
  // 门户用户：注册 → external → 门户岗位 → 名册（联系人上的 portal_user 由系统写入，等同「开通门户」flow）
  const portalUser = async (supplier: string, admin = false): Promise<Person & { contact: string }> => {
    const token = await stack.signUp(`ss-portal-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    expect(await stack.hooks.updateWhere('sys_member', { user_id: id }, { role: 'external' }, { system: true })).toBe(1);
    await assign(id, 'srm_portal_user');
    if (admin) await assign(id, 'srm_portal_admin');
    const contact = await sys('srm_supplier_contact', {
      supplier,
      name: `门户联系人 ${seq}`,
      email: `ss-portal-${seq}@example.com`,
      portal_user: id,
      ...(admin ? { contact_function: ['admin'] } : {}),
    });
    return { token, id, contact: String(contact.id) };
  };

  // screen flow：从按钮启动，停在屏幕上时提交 input；refused / failed 原样返回
  const runScreen = async (as: string, object: string, flow: string, recordId: string, input: Row = {}) => {
    const started = (await stack.actions.run(object, flow, { as, recordId })) as { runId?: string; status?: string };
    if (started.status !== 'paused' || !started.runId) return started as Row;
    return (await stack.flows.resume({ flowName: flow, runId: started.runId }, input, { as })) as Row;
  };
  // 绕过按钮直接启动 flow（任何成员都能经 trigger 入口启动系统身份的 screen flow，objectstack#25481）。
  // 18.3.0 起 trigger 入口先以调用人身份读 recordId（objectstack#29050），读不到答 404，不产生运行，这里记作 not_found
  const startDirect = async (as: string, object: string, flow: string, recordId: string, input: Row = {}) => {
    const started = (await triggerFlow(stack, as, flow, object, recordId).catch((error) => {
      if (/answered 404/.test(String(error))) return { status: 'not_found' };
      throw error;
    })) as { runId?: string; status?: string };
    if (started.status !== 'paused' || !started.runId) return started as Row;
    return (await stack.flows.resume({ flowName: flow, runId: started.runId }, input, { as })) as Row;
  };
  const sweep = async () => {
    const run = await stack.flows.run('srm_certificate_expire_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const pendingApproval = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: string, recordId: string, verdict: 'approve' | 'reject' | 'revise', comment: string = verdict) => {
    const req = await pendingApproval(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
    return req!;
  };
  // 通知：sys_notification 一条 + 每位收件人一条 sys_notification_receipt
  const notified = async (sourceId: string, userId: string) => {
    const notes = await stack.rows('sys_notification', { source_id: sourceId });
    for (const note of notes) {
      const receipts = await stack.rows('sys_notification_receipt', { notification_id: note.id });
      if (receipts.some((r) => String(r.user_id ?? r.recipient_id ?? '') === userId)) return true;
    }
    return false;
  };

  let category: string;
  let sqe: Person;
  let lead: Person;
  let accountant: Person;
  let manager: Person;

  // 合格供应商：营业执照与 ISO 9001 为品类的必备资质；ISO 9001 已过期 → 资质异常
  const qualifiedSupplier = async () => {
    const n = ++seq;
    const name = `示例门户自助有限公司 ${n}`;
    const supplier = String(
      (await sys('srm_supplier', {
        name,
        credit_code: `91000000MA0SSV${String(n).padStart(4, '0')}`,
        legal_representative: '张示例',
        address: { street: '示例路 1 号', city: '苏州', country: 'CN' },
        legacy_imported: true,
      })).id,
    );
    await sys('srm_supplier_category', { supplier, category, status: 'qualified' });
    const license = await sys('srm_supplier_certificate', { supplier, cert_type: 'business_license', cert_no: `BL-${n}`, valid_to: day(3650), attachment: await scan() });
    const iso = await sys('srm_supplier_certificate', { supplier, cert_type: 'iso9001', cert_no: `ISO-${n}`, valid_from: day(-1100), valid_to: day(-1), attachment: await scan() });
    const account = await sys('srm_supplier_bank_account', {
      supplier,
      bank_name: '示例银行',
      branch_name: '示例支行',
      account_name: name,
      account_no: `62220000${String(n).padStart(8, '0')}`,
      status: 'active',
      is_default: true,
    });
    await sweep();
    return { id: supplier, name, license: String(license.id), iso: String(iso.id), account: String(account.id) };
  };

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
    const ctx = await stack.contextFor(admin);
    org = ctx.tenantId ? { organization_id: String(ctx.tenantId) } : {};
    sqe = await person('srm_sqe');
    lead = await person('srm_buyer_lead');
    accountant = await person('srm_ap_accountant');
    manager = await person('srm_category_manager');
    category = String(
      (await sys('srm_category', {
        code: `SSV${++seq}`,
        name: `示例门户自助品类 ${seq}`,
        mandatory_cert_types: ['business_license', 'iso9001'],
        sqe: sqe.id,
        category_manager: manager.id,
      })).id,
    );
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  // 07 §2.2 第 1 步：X 在门户补齐证书，SQE 核验后资质异常解除
  it('clears the qualification alert only after the SQE verifies the certificate the portal uploaded', async () => {
    const x = await qualifiedSupplier();
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(true);
    expect((await row('srm_supplier_certificate', x.iso)).verified).toBe(true);
    const p = await portalUser(x.id);

    const uploaded = await stack.hooks.run(
      'srm_supplier_certificate',
      'insert',
      { supplier: x.id, cert_type: 'iso9001', cert_no: `ISO-NEW-${seq}`, issuer: '示例认证机构', valid_from: day(-1), valid_to: day(1095), attachment: await scan(p.token) },
      { as: p.token },
    );
    expect(await row('srm_supplier_certificate', String(uploaded.id))).toMatchObject({ verified: false, is_mandatory: true });
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(true);
    // 品类的 SQE 收到核验通知
    await expect.poll(() => notified(String(uploaded.id), sqe.id)).toBe(true);

    // 门户用户自己核验不了，过期证书不能核验
    expect((await startDirect(p.token, 'srm_supplier_certificate', 'srm_certificate_verify', String(uploaded.id))).status).toBe('refused');
    expect((await runScreen(sqe.token, 'srm_supplier_certificate', 'srm_certificate_verify', x.iso)).status).toBe('refused');

    const verified = await runScreen(sqe.token, 'srm_supplier_certificate', 'srm_certificate_verify', String(uploaded.id));
    expect(verified.success, JSON.stringify(verified)).toBe(true);
    expect(await row('srm_supplier_certificate', String(uploaded.id))).toMatchObject({ verified: true, verified_by: sqe.id });
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(false);
    // 已核验的证书不再核验
    expect((await runScreen(sqe.token, 'srm_supplier_certificate', 'srm_certificate_verify', String(uploaded.id))).status).toBe('refused');
  });

  // 自解资质异常（04 §3.7）：门户把过期证书的有效期改长，扫描后证书变为有效，但没有核验就不解除
  it('does not let a portal renewal of an expired certificate clear the alert before verification', async () => {
    const x = await qualifiedSupplier();
    const p = await portalUser(x.id);
    const renewed = await stack.hooks.run('srm_supplier_certificate', 'update', { id: x.iso, valid_to: day(700) }, { as: p.token });
    expect(renewed.valid_to).toBe(day(700));
    expect((await row('srm_supplier_certificate', x.iso)).verified).toBe(false);
    await sweep();
    expect((await row('srm_supplier_certificate', x.iso)).status).toBe('valid');
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(true);
    // 状态、核验结论门户改不了
    await expect(stack.hooks.run('srm_supplier_certificate', 'update', { id: x.iso, status: 'valid' }, { as: p.token })).rejects.toBeTruthy();
    await stack.hooks.run('srm_supplier_certificate', 'update', { id: x.iso, verified: true }, { as: p.token }).catch(() => undefined);
    expect((await row('srm_supplier_certificate', x.iso)).verified).toBe(false);

    expect((await runScreen(sqe.token, 'srm_supplier_certificate', 'srm_certificate_verify', x.iso)).success).toBe(true);
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(false);
  });

  // 门户改一张有效证书的内容（含类型）只复位核验，不新标资质异常；不能拿改了类型的证书顶替过期的同类证书
  it('resets verification when the portal edits a valid certificate, without raising a new alert', async () => {
    const x = await qualifiedSupplier();
    const p = await portalUser(x.id);
    const iso14 = await sys('srm_supplier_certificate', { supplier: x.id, cert_type: 'iso14001', cert_no: `E-${seq}`, valid_to: day(800), attachment: await scan() });
    expect((await row('srm_supplier_certificate', String(iso14.id))).verified).toBe(true);
    await stack.hooks.run('srm_supplier_certificate', 'update', { id: String(iso14.id), cert_type: 'iso9001' }, { as: p.token });
    expect((await row('srm_supplier_certificate', String(iso14.id))).verified).toBe(false);
    expect((await row('srm_supplier', x.id)).qualification_alert).toBe(true);

    // 另一家资质正常的供应商：门户改有效的营业执照只复位核验，资质异常不变
    const y = await qualifiedSupplier();
    await stack.hooks.run('srm_supplier_certificate', 'update', { id: y.iso, valid_to: day(500) }, { system: true });
    await sweep();
    expect((await row('srm_supplier', y.id)).qualification_alert).toBe(false);
    const q = await portalUser(y.id);
    await stack.hooks.run('srm_supplier_certificate', 'update', { id: y.license, issuer: '示例市场监管局' }, { as: q.token });
    expect((await row('srm_supplier_certificate', y.license)).verified).toBe(false);
    expect((await row('srm_supplier', y.id)).qualification_alert).toBe(false);
  });

  // 门户提交的变更单经审批写回（issue #80 出口条件）
  it('writes back a basic change the portal admin submitted, after purchasing approval', async () => {
    const x = await qualifiedSupplier();
    const pa = await portalUser(x.id, true);
    const run = await runScreen(pa.token, 'srm_supplier', 'srm_change_submit', x.id, {
      change_type: 'basic',
      reason: '工商变更（示例）',
      new_legal_representative: '王示例',
    });
    expect(run.success, JSON.stringify(run)).toBe(true);
    const [change] = await stack.rows('srm_supplier_change_request', { supplier: x.id });
    expect(change).toMatchObject({ change_type: 'basic', status: 'in_review', approval_status: 'pending', created_by: pa.id, new_legal_representative: '王示例' });
    // 门户能看到自己提交的变更单，别的门户用户（同一家）也能看到
    expect((await stack.rows('srm_supplier_change_request', { id: change!.id }, { as: pa.token })).length).toBe(1);

    await decide(lead.token, String(change!.id), 'approve');
    expect(await row('srm_supplier_change_request', String(change!.id))).toMatchObject({ status: 'applied', purchase_approver: lead.id });
    expect((await row('srm_supplier', x.id)).legal_representative).toBe('王示例');
  });

  it('routes a portal bank account change through finance review and swaps the accounts', async () => {
    const x = await qualifiedSupplier();
    const pa = await portalUser(x.id, true);
    const run = await runScreen(pa.token, 'srm_supplier', 'srm_change_submit', x.id, {
      change_type: 'bank_account',
      reason: '更换收款账户（示例）',
      bank_account: x.account,
      new_bank_name: '示例银行',
      new_branch_name: '示例新支行',
      new_account_name: x.name,
      new_account_no: '6222999900001111',
    });
    expect(run.success, JSON.stringify(run)).toBe(true);
    const [change] = await stack.rows('srm_supplier_change_request', { supplier: x.id });
    await decide(lead.token, String(change!.id), 'approve');
    await decide(accountant.token, String(change!.id), 'approve');
    const done = await row('srm_supplier_change_request', String(change!.id));
    expect(done).toMatchObject({ status: 'applied', finance_approver: accountant.id });
    expect((await row('srm_supplier_bank_account', x.account)).status).toBe('inactive');
    expect(await row('srm_supplier_bank_account', String(done.new_bank_account))).toMatchObject({ status: 'active', account_no: '6222999900001111' });
  });

  it('lets the portal admin revise a returned change and resubmit it', async () => {
    const x = await qualifiedSupplier();
    const pa = await portalUser(x.id, true);
    await runScreen(pa.token, 'srm_supplier', 'srm_change_submit', x.id, { change_type: 'basic', reason: '示例', new_legal_representative: '赵示例' });
    const [change] = await stack.rows('srm_supplier_change_request', { supplier: x.id });
    const id = String(change!.id);
    // 审批中门户改不了
    await stack.hooks.run('srm_supplier_change_request', 'update', { id, new_legal_representative: '孙示例' }, { as: pa.token }).catch(() => undefined);
    expect((await row('srm_supplier_change_request', id)).new_legal_representative).toBe('赵示例');

    const first = await decide(lead.token, id, 'revise', '姓名有误');
    expect((await row('srm_supplier_change_request', id)).approval_status).toBe('returned');
    await stack.hooks.run('srm_supplier_change_request', 'update', { id, new_legal_representative: '钱示例' }, { as: pa.token });
    const res = await stack.apiAs(pa.token, 'POST', `/approvals/requests/${first.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    await decide(lead.token, id, 'approve');
    expect((await row('srm_supplier', x.id)).legal_representative).toBe('钱示例');
  });

  it('refuses the change submission to a plain portal user, an internal user and a forged supplier', async () => {
    const x = await qualifiedSupplier();
    const y = await qualifiedSupplier();
    const plain = await portalUser(x.id);
    const pa = await portalUser(x.id, true);
    const input = { change_type: 'basic', reason: '冒名', new_name: '示例冒名有限公司' };
    expect((await startDirect(plain.token, 'srm_supplier', 'srm_change_submit', x.id, input)).status).toBe('refused');
    expect((await startDirect(manager.token, 'srm_supplier', 'srm_change_submit', x.id, input)).status).toBe('refused');
    // 门户管理员伪造别家的供应商：18.3.0 起入口读不到别家供应商，答「不存在」（objectstack#29050）；flow 的名册检查是第二道防线
    expect((await startDirect(pa.token, 'srm_supplier', 'srm_change_submit', y.id, input)).status).toBe('not_found');
    expect(await stack.rows('srm_supplier_change_request', { supplier: y.id })).toEqual([]);
    // 选别家的银行账户：变更单的校验规则拒绝
    const forged = await runScreen(pa.token, 'srm_supplier', 'srm_change_submit', x.id, {
      change_type: 'bank_account',
      reason: '冒名',
      bank_account: y.account,
      new_bank_name: '示例银行',
      new_account_name: x.name,
      new_account_no: '6222999900002222',
    }).catch((e) => ({ success: false, error: String(e) }));
    expect(forged.success).not.toBe(true);
    expect(await stack.rows('srm_supplier_change_request', { supplier: x.id })).toEqual([]);
  });

  it('lets the portal resubmit an application returned for supplement', async () => {
    const n = ++seq;
    const supplier = String((await sys('srm_supplier', { name: `示例待补充有限公司 ${n}`, credit_code: `91000000MA0SSA${String(n).padStart(4, '0')}` })).id);
    const application = await stack.hooks.run('srm_supplier_application', 'insert', { supplier, applied_categories: [category] }, { as: manager.token });
    const id = String(application.id);
    await stack.hooks.run('srm_supplier_application', 'update', { id, status: 'doc_review' }, { as: manager.token });
    await stack.hooks.run('srm_supplier_application', 'update', { id, status: 'returned', return_reason: '请补传 ISO 9001 证书' }, { as: manager.token });
    const p = await portalUser(supplier);
    const other = await portalUser((await qualifiedSupplier()).id);

    // 别家的门户用户：入口读不到这张申请，答「不存在」（objectstack#29050）；内部员工读得到，由 flow 的名册检查拒绝
    expect((await startDirect(other.token, 'srm_supplier_application', 'srm_application_resubmit', id, { note: '冒名' })).status).toBe('not_found');
    expect((await startDirect(manager.token, 'srm_supplier_application', 'srm_application_resubmit', id, { note: '内部' })).status).toBe('refused');
    const run = await runScreen(p.token, 'srm_supplier_application', 'srm_application_resubmit', id, { note: '已补传 ISO 9001 证书' });
    expect(run.success, JSON.stringify(run)).toBe(true);
    expect(await row('srm_supplier_application', id)).toMatchObject({ status: 'doc_review', supplement_note: '已补传 ISO 9001 证书' });
    // 不是退回补充的申请不能再提交
    expect((await runScreen(p.token, 'srm_supplier_application', 'srm_application_resubmit', id, { note: '再来' })).status).toBe('refused');
    // 门户不能直接改申请
    await expect(stack.hooks.run('srm_supplier_application', 'update', { id, status: 'admission_review' }, { as: p.token })).rejects.toBeTruthy();
  });

  it('lets the portal admin add a bank account that the AP accountant then verifies', async () => {
    const x = await qualifiedSupplier();
    const pa = await portalUser(x.id, true);
    const created = await stack.hooks.run(
      'srm_supplier_bank_account',
      'insert',
      { supplier: x.id, bank_name: '示例银行', branch_name: '示例二支行', account_name: x.name, account_no: '6222888800003333' },
      { as: pa.token },
    );
    const id = String(created.id);
    expect(await row('srm_supplier_bank_account', id)).toMatchObject({ status: 'pending_verify', created_by: pa.id });
    await expect.poll(() => notified(id, accountant.id)).toBe(true);
    // 门户自己置不了有效
    await stack.hooks.run('srm_supplier_bank_account', 'update', { id, status: 'active' }, { as: pa.token }).catch(() => undefined);
    expect((await row('srm_supplier_bank_account', id)).status).toBe('pending_verify');
    const verified = await runScreen(accountant.token, 'srm_supplier_bank_account', 'srm_bank_verify', id);
    expect(verified.success, JSON.stringify(verified)).toBe(true);
    expect(await row('srm_supplier_bank_account', id)).toMatchObject({ status: 'active', verified_by: accountant.id });
  });

  it('lets the portal admin maintain contacts but not a plain portal user', async () => {
    const x = await qualifiedSupplier();
    const pa = await portalUser(x.id, true);
    const plain = await portalUser(x.id);
    const added = await stack.hooks.run('srm_supplier_contact', 'insert', { supplier: x.id, name: '新联系人', email: `new-${seq}@example.com`, mobile: '13900000000' }, { as: pa.token });
    const updated = await stack.hooks.run('srm_supplier_contact', 'update', { id: String(added.id), mobile: '13900000001' }, { as: pa.token });
    expect(updated.mobile).toBe('13900000001');
    await expect(stack.hooks.run('srm_supplier_contact', 'update', { id: String(added.id), mobile: '13900000002' }, { as: plain.token })).rejects.toBeTruthy();
  });
});
