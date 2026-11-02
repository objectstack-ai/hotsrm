import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P10 证书改动核验（03 §11，v0.6）：证书的内容（类型、编号、发证机构、有效期、扫描件）新建或被修改后，按改动人区分：
// - 门户用户（持 srm_portal_user 岗位）改的：「已核验」复位为 false，通知 SQE 经「核验证书」（srm_certificate_verify）
//   核对原件。没核验的证书不能解除资质异常（srm_supplier_qualification_recalc），供应商自己上传或改有效期都解不了；
// - 内部人员或系统写入的：录入即核验（门户上线前证书一直由内部录入，03 §11 注），核验人记为改动人。
// 类型也在监视之列：把一张已核验的 ISO 14001 改成 ISO 9001 同样要重新核验，否则能顶替过期的同类证书。
// 判断改动人读的是 updated_by 的岗位任命，不依赖触发上下文；门户岗位与内部岗位互不兼任（test/portal-isolation.test.ts）。
const watched = ['cert_type', 'cert_no', 'issuer', 'valid_from', 'valid_to', 'attachment'];
const changed = watched.map((f) => `record.${f} != previous.${f}`).join(' || ');
const writer = `has(record.updated_by) && record.updated_by != null ? record.updated_by : (has(record.created_by) && record.created_by != null ? record.created_by : '')`;

export const CertificateChangeCheckFlow: Automation.Flow = {
  name: 'srm_certificate_change_check',
  label: '证书改动核验',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建证书或改了证书内容',
      config: {
        objectName: 'srm_supplier_certificate',
        triggerType: 'record-after-write',
        condition: { dialect: 'cel', source: `previous == null || ${changed}` },
      },
    },
    {
      id: 'find_portal_writer',
      type: 'get_record',
      label: '改动人是门户用户？',
      config: {
        objectName: 'sys_user_position',
        filter: { user_id: { dialect: 'cel', source: writer }, position: 'srm_portal_user' },
        outputVariable: 'portalWriter',
      },
    },
    { id: 'by_portal', type: 'decision', label: '门户改的？' },
    {
      id: 'mark_verified',
      type: 'update_record',
      label: '内部录入即核验',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { id: cel`record.id` },
        fields: { verified: true, verified_by: { dialect: 'cel', source: `${writer} == '' ? null : ${writer}` } },
      },
    },
    {
      id: 'reset_verified',
      type: 'update_record',
      label: '复位「已核验」',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { id: cel`record.id` },
        fields: { verified: false, verified_by: null },
      },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'supplier' },
    },
    {
      id: 'load_grants',
      type: 'get_record',
      label: '读取品类资格',
      config: { objectName: 'srm_supplier_category', filter: { supplier: cel`record.supplier` }, fields: ['category'], limit: 500, outputVariable: 'grants' },
    },
    {
      id: 'load_categories',
      type: 'get_record',
      label: '读取品类的 SQE',
      config: {
        objectName: 'srm_category',
        filter: { id: { $in: cel`grants.map(g, g.category)` } },
        fields: ['sqe'],
        limit: 500,
        outputVariable: 'categories',
      },
    },
    {
      id: 'load_quality_managers',
      type: 'get_record',
      label: '读取质量经理',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_sqe',
              type: 'notify',
              label: '通知 SQE 核验（品类没有 SQE 时通知质量经理）',
              config: {
                recipients: {
                  dialect: 'cel',
                  source:
                    `categories.exists(c, has(c.sqe) && c.sqe != null)`
                    + ` ? categories.filter(c, has(c.sqe) && c.sqe != null).map(c, c.sqe)`
                    + ` : qualityManagers.map(p, p.user_id)`,
                },
                title: '{{ supplier.name }} 在门户提交了证书，待核验',
                message:
                  '供应商在门户新建或修改了资质证书（编号 {{ record.cert_no }}，有效期至 {{ record.valid_to }}）。'
                  + '请核对原件后在证书上点「核验证书」；核验前这张证书不能解除资质异常。',
                severity: 'info',
                sourceObject: 'srm_supplier_certificate',
                sourceId: cel`record.id`,
              },
            },
          ],
        },
        // 没有可通知的人（品类没有 SQE、也没有质量经理）时不影响复位
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_portal_writer', type: 'default' },
    { id: 'e2', source: 'find_portal_writer', target: 'by_portal', type: 'default' },
    { id: 'e3', source: 'by_portal', target: 'mark_verified', type: 'conditional', condition: P`portalWriter == null`, label: '内部' },
    { id: 'e4', source: 'by_portal', target: 'reset_verified', type: 'conditional', condition: P`portalWriter != null`, label: '门户' },
    { id: 'e5', source: 'mark_verified', target: 'end', type: 'default' },
    { id: 'e6', source: 'reset_verified', target: 'load_supplier', type: 'default' },
    { id: 'e7', source: 'load_supplier', target: 'load_grants', type: 'default' },
    { id: 'e8', source: 'load_grants', target: 'load_categories', type: 'default' },
    { id: 'e9', source: 'load_categories', target: 'load_quality_managers', type: 'default' },
    { id: 'e10', source: 'load_quality_managers', target: 'notify_guard', type: 'default' },
    { id: 'e11', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
