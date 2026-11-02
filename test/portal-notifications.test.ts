import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { SrmEmailTemplates, SUPPLIER_TEMPLATE_NAMES } from '../src/core/notifications';

// v0.6 U6（#82）：供应商侧通知（05 §5）。门户用户是组织成员（external），notify 直接发给他们；收件人只取「记录所属供应商」
// 名册上的门户账号（ADR-0010 红线 2），按职能（quality / admin）或门户管理员挑人；没开通门户的供应商不发，内部通知不变。
// 内容走中英文邮件模板，按收件人语言渲染；站内信与邮件同一份。测试数据全部在这里生成。
type Row = Record<string, any>;
type Person = { token: string; id: string };
type Flow = { name: string; nodes: Row[]; edges: Row[] };

const flows = (config.flows ?? []) as unknown as Flow[];
// 展开 try_catch / loop 里嵌套的节点
const allNodes = (nodes: Row[]): Row[] =>
  nodes.flatMap((n) => [n, ...allNodes([...(n.config?.try?.nodes ?? []), ...(n.config?.catch?.nodes ?? []), ...(n.config?.body?.nodes ?? [])])]);
const supplierNotices = flows.flatMap((flow) =>
  allNodes(flow.nodes)
    .filter((n) => n.type === 'notify' && typeof n.config?.template === 'string')
    .map((node) => ({ flow, node })),
);

describe('supplier notification metadata (05 §5)', () => {
  it('ships every supplier template in Chinese and English with the same placeholders', () => {
    const holes = (s: string) => [...s.matchAll(/{{\s*([\w.]+)/g)].map((m) => m[1]).sort();
    for (const name of SUPPLIER_TEMPLATE_NAMES) {
      const members = SrmEmailTemplates.filter((t) => t.name === name);
      expect(members.map((t) => t.locale).sort(), name).toEqual(['en-US', 'zh-CN']);
      const [zh, en] = [members.find((t) => t.locale === 'zh-CN')!, members.find((t) => t.locale === 'en-US')!];
      expect(holes(en.subject + en.bodyText), name).toEqual(holes(zh.subject + zh.bodyText));
      // 不把敏感内容放进邮件：没有金额、账号、分数、等级一类的占位符
      expect(holes(zh.subject + zh.bodyText).filter((h) => /amount|account|score|grade|price/.test(h!)), name).toEqual([]);
    }
  });

  it('feeds every placeholder of each referenced template', () => {
    const used = new Set(supplierNotices.map(({ node }) => node.config.template));
    expect([...used].sort()).toEqual([...SUPPLIER_TEMPLATE_NAMES].sort());
    for (const { flow, node } of supplierNotices) {
      const template = SrmEmailTemplates.find((t) => t.name === node.config.template && t.locale === 'zh-CN')!;
      const holes = [...(template.subject + template.bodyText).matchAll(/{{\s*([\w.]+)/g)].map((m) => m[1]);
      for (const hole of holes.filter((h) => h !== 'appName')) expect(Object.keys(node.config.templateData), `${flow.name} ${node.id} ${hole}`).toContain(hole);
      expect(node.config.channels, `${flow.name} ${node.id}`).toEqual(['inbox', 'email']);
    }
  });

  // 隔离（ADR-0010）：收件人只能从本条记录所属供应商的名册里来，名册条件与成员键一致
  it('takes supplier recipients only from the roster of the record’s own supplier', () => {
    for (const { flow, node } of supplierNotices) {
      const roster = allNodes(flow.nodes).find((n) => n.id === 'load_roster');
      expect(roster, flow.name).toBeTruthy();
      expect(roster!.config.objectName).toBe('srm_supplier_contact');
      expect(roster!.config.filter.active, flow.name).toBe(true);
      expect(roster!.config.filter.portal_user, flow.name).toEqual({ $ne: null });
      // 名册的供应商就是触发记录（处置执行子 flow 里是按 id 读出的处置单 disp）自己的供应商
      expect(['record.supplier', 'disp.supplier'], flow.name).toContain(roster!.config.filter.supplier.source);
      const recipients = String(node.config.recipients.source);
      expect(/roster|portalAdmins/.test(recipients), `${flow.name} ${node.id}`).toBe(true);
      // 门户管理员也只在名册的门户账号里找
      if (recipients.includes('portalAdmins')) {
        const admins = allNodes(flow.nodes).find((n) => n.id === 'load_portal_admins')!;
        expect(admins.config.filter.user_id.$in.source).toBe('roster.map(r, r.portal_user)');
      }
      // 记录触发、定时或系统身份的子 flow：门户用户不能经 trigger 入口直接启动（只有 screen flow 才要在 flow 里查调用者的名册）
      expect(['record_change', 'schedule', 'autolaunched'], flow.name).toContain((config.flows ?? []).find((f) => f.name === flow.name)!.type);
    }
  });
});

describe('supplier notifications (05 §5, v0.6 U6)', () => {
  let stack: VerifyStack;
  let seq = 0;
  let org: Record<string, string> = {};
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const sys = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as Row;
  const update = (object: string, id: string, doc: Row) => stack.hooks.run(object, 'update', { id, ...doc }, { system: true });
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const assign = (userId: string, position: string) => stack.seed('sys_user_position', [{ user_id: userId, position, ...org }]);
  const person = async (position: string): Promise<Person> => {
    const token = await stack.signUp(`notice-${position}-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    await assign(id, position);
    return { token, id };
  };
  type Portal = Person & { contact: string };
  const portalUser = async (supplier: string, contactFunction: string[], opts: { admin?: boolean; locale?: string; active?: boolean } = {}): Promise<Portal> => {
    const token = await stack.signUp(`notice-portal-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    expect(await stack.hooks.updateWhere('sys_member', { user_id: id }, { role: 'external' }, { system: true })).toBe(1);
    if (opts.locale) await stack.hooks.run('sys_user', 'update', { id, locale: opts.locale }, { system: true });
    await assign(id, 'srm_portal_user');
    if (opts.admin) await assign(id, 'srm_portal_admin');
    const contact = await sys('srm_supplier_contact', {
      supplier,
      name: `示例门户联系人 ${seq}`,
      email: `notice-portal-${seq}@example.com`,
      contact_function: contactFunction,
      portal_user: id,
      active: opts.active ?? true,
    });
    return { token, id, contact: String(contact.id) };
  };
  // 存量导入的供应商建档即合格；潜在供应商正常新建
  const vendor = async (name: string, status: 'qualified' | 'potential' = 'qualified') => {
    const doc = { name, credit_code: `91000000MA0NT${String(++seq).padStart(4, '0')}0` };
    return String((await sys('srm_supplier', status === 'qualified' ? { ...doc, legacy_imported: true } : doc)).id);
  };

  // 站内信经消息服务异步投递：等到收齐 count 条（或超时）再读
  const inbox = async (userId: string, recordId: string, count = 1) => {
    const read = async () => (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));
    for (let i = 0; i < 60 && (await read()).length < count; i++) await new Promise((r) => setTimeout(r, 50));
    return read();
  };
  // 一条记录的全部供应商侧通知（topic srm_supplier）的收件人
  const supplierRecipients = async (recordId: string) => {
    const notes = (await stack.rows('sys_notification', { source_id: recordId })).filter((n) => n.topic === 'srm_supplier');
    const receipts = await Promise.all(notes.map((n) => stack.rows('sys_notification_receipt', { notification_id: n.id })));
    return receipts.flat().map((r) => String(r.user_id ?? r.recipient_id)).sort();
  };
  const pending = async (recordId: string) => (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject' | 'revise', comment: string = verdict) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const runScreen = async (as: Person, object: string, flow: string, recordId: string, input: Row = {}) => {
    let res = (await stack.actions.run(object, flow, { as: as.token, recordId })) as Row;
    while (res.status === 'paused' && res.runId) res = (await stack.flows.resume({ flowName: flow, runId: res.runId }, input, { as: as.token })) as Row;
    return res;
  };

  let sqe: Person;
  let lead: Person;
  let accountant: Person;
  let director: Person;
  let buyer: Person;
  let category: string;
  let material: string;
  // A：质量、主账号（门户管理员、英文）、商务各一位，另有一位已停用的质量联系人；B：只有主账号；C：没开通门户
  let a: string;
  let b: string;
  let c: string;
  let aQuality: Portal;
  let aAdmin: Portal;
  let aSales: Portal;
  let aInactive: Portal;
  let bAdmin: Portal;
  const aPortal = () => [aQuality.id, aAdmin.id, aSales.id, aInactive.id];

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，证书到期提醒才能由平台的扫描任务触发
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    const ctx = await stack.contextFor(await stack.signIn());
    org = ctx.tenantId ? { organization_id: String(ctx.tenantId) } : {};
    sqe = await person('srm_sqe');
    lead = await person('srm_buyer_lead');
    accountant = await person('srm_ap_accountant');
    director = await person('srm_procurement_director');
    buyer = await person('srm_buyer_lead');
    category = String((await sys('srm_category', { code: `NTC-${++seq}`, name: '示例品类（供应商通知）', sqe: sqe.id })).id);
    material = String((await sys('srm_material', { erp_material_no: `EX-NTC-${++seq}`, material_code: `M-NTC-${seq}`, name: '示例冲压件', category })).id);
    a = await vendor('示例通知甲有限公司');
    b = await vendor('示例通知乙有限公司');
    c = await vendor('示例通知丙有限公司');
    await stack.seed('srm_supplier_category', [{ supplier: a, category, status: 'qualified', ...org }]);
    aQuality = await portalUser(a, ['quality']);
    aAdmin = await portalUser(a, ['admin'], { admin: true, locale: 'en' });
    aSales = await portalUser(a, ['sales']);
    aInactive = await portalUser(a, ['quality'], { active: false });
    bAdmin = await portalUser(b, ['admin'], { admin: true });
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  const scar = async (supplier: string, doc: Row = {}) =>
    String((await sys('srm_quality_issue', { supplier, material, severity: 'major', problem_description: '示例：来料尺寸超差', sqe: sqe.id, ...doc })).id);
  const seedScar = async (supplier: string, doc: Row) =>
    String((await stack.seed('srm_quality_issue', [{ supplier, material, severity: 'major', problem_description: '示例：来料尺寸超差', sqe: sqe.id, ...org, ...doc }]))[0]!.id);

  it('tells the supplier’s quality contact about a new SCAR, in the recipient’s language, and nobody at another supplier', async () => {
    const id = await scar(a);
    const [note] = await inbox(aQuality.id, id);
    const issue = await row('srm_quality_issue', id);
    expect(note!.title).toBe(`新整改单 ${issue.issue_no}：请提交临时措施`);
    expect(note!.body_md).toContain('示例通知甲有限公司');
    expect(note!.body_md).not.toContain('来料尺寸超差');
    expect(await supplierRecipients(id)).toEqual([aQuality.id]);

    // B 没有质量联系人：发给主账号；A 的人一个都收不到
    const other = await scar(b);
    const [english] = await inbox(bAdmin.id, other);
    expect(english!.title).toContain('新整改单');
    expect(await supplierRecipients(other)).toEqual([bAdmin.id]);
    for (const user of aPortal()) expect(await inbox(user, other, 0)).toEqual([]);
  }, 30_000);

  it('sends nothing to the supplier side when the supplier has no portal account', async () => {
    const id = await scar(c);
    await new Promise((r) => setTimeout(r, 300));
    expect(await supplierRecipients(id)).toEqual([]);
    expect((await row('srm_quality_issue', id)).status).toBe('open');
  }, 30_000);

  it('tells the quality contact when the SQE returns D4–D7, when the SCAR reopens, when a claim is raised and when it goes overdue', async () => {
    const returned = await seedScar(a, {
      status: 'action_submitted',
      containment_action: '示例：在库品全检隔离',
      root_cause: '示例：模具磨损',
      corrective_action: '示例：更换模具并加首件检验',
    });
    await update('srm_quality_issue', returned, { status: 'containment_submitted', sqe_comment: '示例：根因分析不充分' });
    const [back] = await inbox(aQuality.id, returned);
    expect(back!.title).toContain('根因与措施被退回');
    expect(back!.body_md).not.toContain('根因分析不充分');

    const reopened = await seedScar(a, {
      status: 'closed',
      containment_due: '2026-01-01T00:00:00.000Z',
      final_due: '2026-01-31',
      containment_action: '示例：在库品全检隔离',
      root_cause: '示例：模具磨损',
      corrective_action: '示例：更换模具并加首件检验',
    });
    await update('srm_quality_issue', reopened, { status: 'open' });
    const [again] = await inbox(aQuality.id, reopened);
    expect(again!.title).toContain('重新打开');
    // 期限是重开时重算过的，不是关闭前的旧期限
    expect(again!.body_md).not.toContain('2026/1/31');
    expect(again!.body_md).toContain(String((await row('srm_quality_issue', reopened)).final_due).replace(/-0?/g, '/'));

    const late = await seedScar(a, { status: 'open', is_overdue: false, containment_due: new Date(Date.now() - 3_600_000).toISOString() });
    const run = await stack.flows.run('srm_scar_overdue_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
    const [overdue] = await inbox(aQuality.id, late);
    expect(overdue!.title).toContain('已逾期');
    // SQE 提出索赔：通知里没有金额（R5），请供应商到门户确认
    const claimed = await seedScar(a, { status: 'verifying', containment_action: '示例：在库品全检隔离', root_cause: '示例：模具磨损', corrective_action: '示例：更换模具' });
    await update('srm_quality_issue', claimed, { claim_amount: 3600, claim_status: 'proposed' });
    const [claim] = await inbox(aQuality.id, claimed);
    expect(claim!.title).toContain('提出了索赔');
    expect(claim!.body_md).not.toContain('3600');
    expect(claim!.body_md).not.toContain('3,600');
    for (const id of [returned, reopened, late, claimed]) expect(await supplierRecipients(id)).toEqual([aQuality.id]);
  }, 30_000);

  it('warns the SQE and the supplier’s admin and quality contacts before and when a certificate expires', async () => {
    const expiring = String((await sys('srm_supplier_certificate', { supplier: a, cert_type: 'iso9001', cert_no: 'NTC-ISO-1', valid_from: day(-700), valid_to: day(30), legacy_imported: true })).id);
    const notDue = String((await sys('srm_supplier_certificate', { supplier: a, cert_type: 'iso14001', cert_no: 'NTC-ISO-2', valid_from: day(-700), valid_to: day(31), legacy_imported: true })).id);
    const job = stack.kernel.getService<{ trigger(name: string): Promise<unknown> }>('job');
    await job.trigger('flow-time-relative:srm_certificate_expiry_notice');
    const [zh] = await inbox(aQuality.id, expiring);
    expect(zh!.title).toBe(`示例通知甲有限公司：资质证书将于 ${zh!.title.match(/\d.*\d/)![0]} 到期`);
    expect(zh!.body_md).toContain('NTC-ISO-1');
    // 门户管理员选了英文
    const [en] = await inbox(aAdmin.id, expiring);
    expect(en!.title).toContain('a certificate expires on');
    expect(await inbox(sqe.id, expiring)).toHaveLength(1);
    expect(await supplierRecipients(expiring)).toEqual([aQuality.id, aAdmin.id].sort());
    expect(await stack.rows('sys_notification', { source_id: notDue })).toHaveLength(0);
    // 同一提醒日再扫一次不重复发
    await job.trigger('flow-time-relative:srm_certificate_expiry_notice');
    expect(await stack.rows('sys_notification', { source_id: expiring })).toHaveLength(2);

    const expired = String((await sys('srm_supplier_certificate', { supplier: a, cert_type: 'iso45001', cert_no: 'NTC-ISO-3', valid_from: day(-700), valid_to: day(-1), legacy_imported: true })).id);
    const sweep = await stack.flows.run('srm_certificate_expire_sweep', {}, { system: true });
    expect(sweep.success, JSON.stringify(sweep)).toBe(true);
    expect((await row('srm_supplier_certificate', expired)).status).toBe('expired');
    const [gone] = await inbox(aQuality.id, expired);
    expect(gone!.title).toBe('示例通知甲有限公司：资质证书已过期');
    expect(await inbox(sqe.id, expired)).toHaveLength(1);
    expect(await supplierRecipients(expired)).toEqual([aQuality.id, aAdmin.id].sort());
  }, 30_000);

  it('keeps the applicant contact informed of a portal-submitted application', async () => {
    const p = await vendor('示例通知丁有限公司', 'potential');
    const applicant = await portalUser(p, ['sales']);
    const colleague = await portalUser(p, ['admin']);
    const id = String((await sys('srm_supplier_application', { supplier: p, applied_categories: [category], contact: applicant.contact })).id);
    // contact 是只读字段：系统身份写得进去（门户里由「提交准入申请」写）
    expect((await row('srm_supplier_application', id)).contact).toBe(applicant.contact);
    const [accepted] = await inbox(applicant.id, id);
    const app = await row('srm_supplier_application', id);
    expect(accepted!.title).toBe(`准入申请 ${app.application_no} 已受理`);

    await update('srm_supplier_application', id, { status: 'returned', return_reason: '示例：请补传 ISO 9001 证书' });
    expect((await inbox(applicant.id, id, 2)).map((m) => m.title)).toContain(`准入申请 ${app.application_no} 需要补充资料`);
    // 供应商重新提交回到资料审核：不再发「已受理」
    await update('srm_supplier_application', id, { status: 'doc_review' });
    await update('srm_supplier_application', id, { status: 'rejected', reject_reason: '示例：资料不全' });
    const titles = (await inbox(applicant.id, id, 3)).map((m) => m.title);
    expect(titles).toContain(`准入申请 ${app.application_no} 未通过`);
    expect(titles).toHaveLength(3);
    // 只发申请联系人；未通过后门户已回收
    expect(await supplierRecipients(id)).toEqual([applicant.id, applicant.id, applicant.id]);
    expect(await inbox(colleague.id, id, 0)).toEqual([]);
    expect((await row('srm_supplier_contact', applicant.contact)).portal_user ?? null).toBeNull();

    // 内部登记的申请没有申请联系人：不发供应商
    const q = await vendor('示例通知戊有限公司', 'potential');
    await portalUser(q, ['admin']);
    const internal = String((await sys('srm_supplier_application', { supplier: q, applied_categories: [category] })).id);
    expect((await row('srm_supplier_application', internal)).status).toBe('doc_review');
    await new Promise((r) => setTimeout(r, 300));
    expect(await supplierRecipients(internal)).toEqual([]);
  }, 30_000);

  it('tells the applicant contact when the application is approved', async () => {
    const p = await vendor('示例通知己有限公司', 'potential');
    const applicant = await portalUser(p, ['admin']);
    const [seeded] = await stack.seed('srm_supplier_application', [
      { supplier: p, applied_categories: [category], contact: applicant.contact, source: 'invited', status: 'admission_review', reviewer: director.id, ...org },
    ]);
    const id = String(seeded!.id);
    await update('srm_supplier', p, { status: 'qualifying' });
    await update('srm_supplier_application', id, { status: 'approved' });
    const [approved] = await inbox(applicant.id, id);
    expect(approved!.title).toContain('已通过');
  }, 30_000);

  it('tells the admin contact when performance is published and when the appeal is resolved, without the internal relay', async () => {
    const today = day(0);
    const [review] = await stack.seed('srm_performance_review', [
      { supplier: a, cycle: 'monthly', period: '2026-08', period_start: '2026-08-01', period_end: '2026-08-31', status: 'reviewing', total_score: 95, grade: 'grade_a', ...org },
    ]);
    const id = String(review!.id);
    await update('srm_performance_review', id, { status: 'published', published_date: today });
    const [published] = await inbox(aAdmin.id, id);
    expect(published!.title).toBe('Performance results for 2026-08 published');
    expect(published!.body_md).not.toContain('95');
    expect(await supplierRecipients(id)).toEqual([aAdmin.id]);

    // 门户管理员申诉，采购总监处理：门户管理员只收到中英文模板的那一条，不收「请把结果告知供应商」
    await runScreen(aAdmin, 'srm_performance_review', 'srm_appeal_submit', id, { appeal_text: '示例申诉' });
    expect((await row('srm_performance_review', id)).status).toBe('appealed');
    await runScreen(director, 'srm_performance_review', 'srm_appeal_resolve', id, { outcome: 'maintained', result_text: '示例：维持原结果' });
    expect((await row('srm_performance_review', id)).status).toBe('published');
    const notes = await inbox(aAdmin.id, id, 2);
    expect(notes.map((m) => m.title).sort()).toEqual([`Appeal on performance review ${(await row('srm_performance_review', id)).review_no} resolved`, 'Performance results for 2026-08 published'].sort());
    await new Promise((r) => setTimeout(r, 300));
    expect(await inbox(aAdmin.id, id, 3)).toHaveLength(2);
    for (const user of [aQuality.id, aSales.id, bAdmin.id]) expect(await inbox(user, id, 0)).toEqual([]);
  }, 30_000);

  it('tells the portal administrators about a verified bank account and change request results', async () => {
    const account = String((await sys('srm_supplier_bank_account', { supplier: a, bank_name: '示例银行', branch_name: '示例支行', account_name: '示例通知甲有限公司', account_no: '6222000011112222', currency: 'cny' })).id);
    expect((await row('srm_supplier_bank_account', account)).status).toBe('pending_verify');
    const verified = await runScreen(accountant, 'srm_supplier_bank_account', 'srm_bank_verify', account);
    expect((await row('srm_supplier_bank_account', account)).status, JSON.stringify(verified)).toBe('active');
    const [bank] = await inbox(aAdmin.id, account);
    expect(bank!.title).toBe('示例通知甲有限公司: bank account verified');
    expect(bank!.body_md).not.toContain('2222');
    expect(await supplierRecipients(account)).toEqual([aAdmin.id]);

    // 门户管理员提交的变更单：退回修改、生效都只收模板通知，不收内部措辞的那条
    const run = await runScreen(aAdmin, 'srm_supplier', 'srm_change_submit', a, { change_type: 'basic', reason: '示例', new_legal_representative: '王示例' });
    expect(run.success, JSON.stringify(run)).toBe(true);
    const [change] = await stack.rows('srm_supplier_change_request', { supplier: a });
    const cid = String(change!.id);
    await decide(lead, cid, 'revise', '示例：姓名有误');
    expect((await inbox(aAdmin.id, cid)).map((m) => m.title)).toEqual([`Change request ${change!.change_no} returned for revision`]);
    const req = (await stack.rows('sys_approval_request', { record_id: cid })).find((r) => r.status !== 'approved');
    const res = await stack.apiAs(aAdmin.token, 'POST', `/approvals/requests/${req!.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    await decide(lead, cid, 'approve');
    expect((await row('srm_supplier_change_request', cid)).status).toBe('applied');
    const titles = (await inbox(aAdmin.id, cid, 2)).map((m) => m.title);
    expect(titles).toContain(`Change request ${change!.change_no} approved and applied`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await inbox(aAdmin.id, cid, 3)).toHaveLength(2);
    expect(await inbox(aQuality.id, cid, 0)).toEqual([]);

    // 内部发起的变更单被驳回：发起人照旧收到内部通知，供应商门户管理员收到模板通知
    const internal = String((await stack.hooks.run('srm_supplier_change_request', 'insert', { supplier: a, change_type: 'basic', reason: '示例', new_legal_representative: '李示例' }, { as: buyer.token }) as Row).id);
    await decide(lead, internal, 'reject', '示例：无依据');
    expect((await row('srm_supplier_change_request', internal)).status).toBe('rejected');
    expect((await inbox(buyer.id, internal)).map((m) => m.title)).toEqual([`变更单 ${(await row('srm_supplier_change_request', internal)).change_no} 已驳回`]);
    expect((await inbox(aAdmin.id, internal)).map((m) => m.title)[0]).toContain('rejected');
  }, 30_000);

  it('tells the admin contact about a freeze, an unfreeze and an elimination, before the portal is revoked', async () => {
    const p = await vendor('示例通知辛有限公司');
    const admin = await portalUser(p, ['admin'], { locale: 'en' });
    const quality = await portalUser(p, ['quality']);
    const disposition = async (action: string) => {
      const [d] = await stack.seed('srm_supplier_disposition', [{ supplier: p, action, scope: 'all', reason: '示例：交付持续不达标', status: 'in_review', ...org }]);
      const run = await stack.flows.run('srm_disposition_apply', { recordId: String(d!.id) }, { system: true });
      expect(run.success, JSON.stringify(run)).toBe(true);
    };
    await disposition('freeze');
    const [frozen] = await inbox(admin.id, p);
    expect(frozen!.title).toBe('示例通知辛有限公司: qualification to supply frozen');
    expect(frozen!.body_md).toContain('all categories');
    expect(frozen!.body_md).not.toContain('交付持续不达标');
    await disposition('unfreeze');
    expect((await inbox(admin.id, p, 2)).map((m) => m.title)).toContain('示例通知辛有限公司: qualification to supply restored');
    await disposition('eliminate');
    expect((await inbox(admin.id, p, 3)).map((m) => m.title)).toContain('示例通知辛有限公司: qualified supplier status ended');
    expect((await row('srm_supplier_contact', admin.contact)).portal_user ?? null).toBeNull();
    expect(await inbox(quality.id, p, 0)).toEqual([]);
  }, 30_000);

  it('tells the invited contact that the portal is open, and only that contact', async () => {
    const p = await vendor('示例通知庚有限公司', 'potential');
    const token = await stack.signUp(`notice-open-${++seq}@example.com`);
    const user = String((await stack.contextFor(token)).userId);
    const contact = String((await sys('srm_supplier_contact', { supplier: p, name: '示例受邀联系人', email: `notice-open-${seq}@example.com`, contact_function: ['admin'] })).id);
    const other = await portalUser(p, ['admin']);
    const invitation = String((await sys('srm_supplier_invitation', { supplier: p, contact, categories: [category] })).id);
    await update('srm_supplier_contact', contact, { portal_user: user });
    await update('srm_supplier_invitation', invitation, { status: 'accepted', portal_user: user });
    const [opened] = await inbox(user, p);
    expect(opened!.title).toBe('示例通知庚有限公司：供应商门户账号已开通');
    expect(await inbox(other.id, p, 0)).toEqual([]);
  }, 30_000);
});
