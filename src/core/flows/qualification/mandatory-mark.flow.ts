import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P10 必备资质标记（02 §4.1 is_mandatory，03 §11）：证书的类型在供应商任一品类的必备资质类型（srm_category.mandatory_cert_types）
// 里时，「必备资质」由 flow 置为 true；标记变化后 srm_supplier_qualification_recalc 照常重算资质异常、生成资质风险事件。
// 两个入口：新建证书（或改了类型、供应商）时看这张证书；新增品类资格（准入通过、重新准入恢复）时看该供应商的全部证书——
// 准入前登记的营业执照、ISO 9001 在准入通过后才有品类可对照。
// 只标记、不取消：存量导入的证书和手工标记的「必备」保留（存量供应商导入时还没有品类资格，必备资质按表格填写，
// docs/implementation/legacy-supplier-import.md）。品类调整必备资质类型后不回溯已有证书，由 SQE 手工补标。

const has = (k: string) => `(has(${k}) && ${k} != null)`;

// 新建或改了类型的证书：查供应商全部品类的必备资质类型
export const CertificateMandatoryMarkFlow: Automation.Flow = {
  name: 'srm_certificate_mandatory_mark',
  label: '证书必备资质标记',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建证书或改了类型、供应商',
      config: {
        objectName: 'srm_supplier_certificate',
        triggerType: 'record-after-write',
        condition: P`(!has(record.is_mandatory) || record.is_mandatory != true)
          && (previous == null || record.cert_type != previous.cert_type || record.supplier != previous.supplier)`,
      },
    },
    {
      id: 'find_grants',
      type: 'get_record',
      label: '读取品类资格',
      config: {
        objectName: 'srm_supplier_category',
        filter: { supplier: cel`record.supplier` },
        fields: ['category'],
        limit: 500,
        outputVariable: 'grants',
      },
    },
    {
      id: 'find_categories',
      type: 'get_record',
      label: '读取所供品类的必备资质类型',
      config: {
        objectName: 'srm_category',
        filter: { id: { $in: cel`grants.map(g, g.category)` } },
        fields: ['mandatory_cert_types'],
        limit: 500,
        outputVariable: 'cats',
      },
    },
    { id: 'is_mandatory', type: 'decision', label: '类型在必备资质里？' },
    {
      id: 'mark',
      type: 'update_record',
      label: '标记必备资质',
      config: { objectName: 'srm_supplier_certificate', filter: { id: cel`record.id` }, fields: { is_mandatory: true } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_grants', type: 'default' },
    { id: 'e2', source: 'find_grants', target: 'find_categories', type: 'default' },
    { id: 'e3', source: 'find_categories', target: 'is_mandatory', type: 'default' },
    {
      id: 'e4',
      source: 'is_mandatory',
      target: 'mark',
      type: 'conditional',
      condition: { dialect: 'cel', source: `cats.exists(x, ${has('x.mandatory_cert_types')} && record.cert_type in x.mandatory_cert_types)` },
      label: '是',
    },
    {
      id: 'e5',
      source: 'is_mandatory',
      target: 'end',
      type: 'conditional',
      condition: { dialect: 'cel', source: `!cats.exists(x, ${has('x.mandatory_cert_types')} && record.cert_type in x.mandatory_cert_types)` },
      label: '不是',
    },
    { id: 'e6', source: 'mark', target: 'end', type: 'default' },
  ],
};

// 新增品类资格：该供应商这个品类必备类型的证书逐张标记（每张一次更新，触发资质异常重算；失败只跳过该张）
export const GrantMandatoryMarkFlow: Automation.Flow = {
  name: 'srm_grant_mandatory_mark',
  label: '品类资格必备资质标记',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新增品类资格或改了品类',
      config: {
        objectName: 'srm_supplier_category',
        triggerType: 'record-after-write',
        condition: P`previous == null || record.category != previous.category`,
      },
    },
    {
      id: 'load_category',
      type: 'get_record',
      label: '读取品类',
      config: { objectName: 'srm_category', filter: { id: cel`record.category` }, fields: ['mandatory_cert_types'], outputVariable: 'grantCategory' },
    },
    { id: 'has_types', type: 'decision', label: '品类有必备资质类型？' },
    {
      id: 'find_certificates',
      type: 'get_record',
      label: '未标记的必备类型证书',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { supplier: cel`record.supplier`, is_mandatory: { $ne: true }, cert_type: { $in: cel`grantCategory.mandatory_cert_types` } },
        fields: ['id'],
        limit: 500,
        outputVariable: 'certificates',
      },
    },
    {
      id: 'each_certificate',
      type: 'loop',
      label: '逐张标记',
      config: {
        collection: cel`certificates`,
        iteratorVariable: 'cert',
        body: {
          nodes: [
            {
              id: 'guard',
              type: 'try_catch',
              label: '单张证书',
              config: {
                try: {
                  nodes: [
                    {
                      id: 'mark',
                      type: 'update_record',
                      label: '标记必备资质',
                      config: { objectName: 'srm_supplier_certificate', filter: { id: cel`cert.id` }, fields: { is_mandatory: true } },
                    },
                  ],
                },
                catch: { nodes: [{ id: 'skip', type: 'assignment', label: '跳过该张' }] },
              },
            },
          ],
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_category', type: 'default' },
    { id: 'e2', source: 'load_category', target: 'has_types', type: 'default' },
    {
      id: 'e3',
      source: 'has_types',
      target: 'find_certificates',
      type: 'conditional',
      condition: { dialect: 'cel', source: `grantCategory != null && ${has('grantCategory.mandatory_cert_types')} && size(grantCategory.mandatory_cert_types) > 0` },
      label: '有',
    },
    {
      id: 'e4',
      source: 'has_types',
      target: 'end',
      type: 'conditional',
      condition: { dialect: 'cel', source: `!(grantCategory != null && ${has('grantCategory.mandatory_cert_types')} && size(grantCategory.mandatory_cert_types) > 0)` },
      label: '没有',
    },
    { id: 'e5', source: 'find_certificates', target: 'each_certificate', type: 'default' },
    { id: 'e6', source: 'each_certificate', target: 'end', type: 'default' },
  ],
};
