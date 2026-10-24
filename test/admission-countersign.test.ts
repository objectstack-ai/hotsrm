import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, Supplier, SupplierApplication } from '../src/core/objects';

// v0.4 Q0：A 类物资或高风险品类的准入，第 2 级由采购总监、质量经理并行会签（03 §3 步骤 6、§12）。
// 受理时把申请品类中最高的物资类别与风险等级复制到申请。岗位都有人任命，所以单独起一个栈，
// 不影响 admission.test.ts 里由管理员兜底审批的用例。测试数据全部在这里生成。
describe('admission countersign by the quality manager', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (...positions: string[]) => {
    const token = await stack.signUp(`qm-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const system = (object: string, doc: Record<string, unknown>) =>
    stack.hooks.run(object, 'insert', doc, { system: true }) as Promise<{ id: string }>;
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;

  const category = async (material_class: string, risk_class: string) => {
    const n = ++seq;
    return (await system(Category.name, { code: `QMC${n}`, name: `示例会签品类 ${n}`, material_class, risk_class })).id;
  };

  let manager: { token: string; id: string };
  let director: { token: string; id: string };
  let quality: { token: string; id: string };

  const apply = async (categories: string[]) => {
    const n = ++seq;
    const supplier = await system(Supplier.name, { name: `示例会签测试有限公司 ${n}`, credit_code: `91000000MA0QMC${String(n).padStart(4, '0')}` });
    const app = await stack.hooks.run(
      SupplierApplication.name,
      'insert',
      { supplier: supplier.id, applied_categories: categories, reviewer: manager.id },
      { as: manager.token },
    );
    return String(app.id);
  };
  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: string, recordId: string, verdict: 'approve' | 'reject') => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment: verdict });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  // 推进到准入评审，品类经理通过第 1 级
  const toSecondLevel = async (app: string) => {
    await stack.hooks.run(SupplierApplication.name, 'update', { id: app, status: 'admission_review' }, { as: manager.token });
    await decide(manager.token, app, 'approve');
  };
  const status = async (app: string) => (await row(SupplierApplication.name, app)).status;

  beforeAll(async () => {
    stack = await bootStack(config);
    manager = await person('srm_category_manager');
    director = await person('srm_procurement_director');
    quality = await person('srm_quality_manager');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('copies the highest material class and risk class of the applied categories', async () => {
    const app = await apply([await category('class_c', 'low'), await category('class_b', 'high'), await category('class_c', 'medium')]);
    expect(await row(SupplierApplication.name, app)).toMatchObject({ material_class: 'class_b', risk_class: 'high' });
    const low = await apply([await category('class_c', 'low')]);
    expect(await row(SupplierApplication.name, low)).toMatchObject({ material_class: 'class_c', risk_class: 'low' });
  });

  it('needs both the director and the quality manager for a class A application', async () => {
    const app = await apply([await category('class_a', 'medium')]);
    await toSecondLevel(app);

    await decide(director.token, app, 'approve');
    expect(await status(app)).toBe('admission_review');
    await decide(quality.token, app, 'approve');
    expect(await status(app)).toBe('approved');
  });

  it('needs the quality manager for a high-risk application whatever the material class', async () => {
    const app = await apply([await category('class_c', 'high')]);
    await toSecondLevel(app);

    await decide(quality.token, app, 'approve');
    expect(await status(app)).toBe('admission_review');
    await decide(director.token, app, 'approve');
    expect(await status(app)).toBe('approved');
  });

  it('returns the application to document review when the quality manager rejects', async () => {
    const app = await apply([await category('class_a', 'high')]);
    await toSecondLevel(app);

    await decide(director.token, app, 'approve');
    await decide(quality.token, app, 'reject');
    expect(await status(app)).toBe('doc_review');
  });

  it('leaves the quality manager out of a class B, medium-risk application', async () => {
    const app = await apply([await category('class_b', 'medium')]);
    await toSecondLevel(app);

    await decide(director.token, app, 'approve');
    expect(await status(app)).toBe('approved');
  });
});
