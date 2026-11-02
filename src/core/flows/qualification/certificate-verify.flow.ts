import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 核验证书（03 §3 第 4 步、§11，v0.6）：供应商在门户上传或修改的证书「已核验」为 false，SQE 或质量经理核对原件后在这里确认，
// 「已核验」置为 true 并记下核验人；资质异常重算（srm_supplier_qualification_recalc）随之判断能否解除。
// 只核验未核验、未过期的证书：过期证书核验了也不能顶替，应由供应商上传新证书。
// 以系统身份运行，因为「已核验」对所有人只读；岗位检查写在 flow 里（同 srm_bank_verify，objectstack#25481）。
const allowed = `current_user != null && ('srm_sqe' in current_user.positions || 'srm_quality_manager' in current_user.positions)`;
const pending = `certificate != null && certificate.verified != true`;
const notExpired = `certificate.status != 'expired'`;

export const CertificateVerifyFlow: Automation.Flow = {
  name: 'srm_certificate_verify',
  label: '核验证书',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '证书已核验',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取证书',
      config: { objectName: 'srm_supplier_certificate', filter: { id: cel`recordId` }, outputVariable: 'certificate' },
    },
    { id: 'gate', type: 'decision', label: '可以核验？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是 SQE',
      config: { outcome: 'refused', message: '只有 SQE 或质量经理可以核验证书' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '已核验',
      config: { outcome: 'refused', message: '这张证书已经核验过' },
    },
    {
      id: 'refuse_expired',
      type: 'end',
      label: '已过期',
      config: { outcome: 'refused', message: '证书已过期，核验后也不能解除资质异常；请供应商上传新证书' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '核对证书',
      config: {
        title: '核验证书：{{ certificate.cert_no }}',
        description:
          '发证机构：{{ certificate.issuer }}\n有效期：{{ certificate.valid_from }} 至 {{ certificate.valid_to }}\n'
          + '请打开扫描件，与原件或发证机构的公开查询结果核对编号、持证单位和有效期，一致后确认核验。',
        waitForInput: true,
      },
    },
    {
      id: 'verify',
      type: 'update_record',
      label: '置为已核验',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { id: cel`certificate.id` },
        fields: { verified: true, verified_by: cel`current_user.id` },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    { id: 'e2', source: 'gate', target: 'refuse_position', type: 'conditional', condition: { dialect: 'cel', source: `!(${allowed})` }, label: '不是 SQE' },
    { id: 'e3', source: 'gate', target: 'refuse_status', type: 'conditional', condition: { dialect: 'cel', source: `${allowed} && !(${pending})` }, label: '已核验' },
    {
      id: 'e4',
      source: 'gate',
      target: 'refuse_expired',
      type: 'conditional',
      condition: { dialect: 'cel', source: `${allowed} && ${pending} && !(${notExpired})` },
      label: '已过期',
    },
    { id: 'e5', source: 'gate', target: 'confirm', type: 'conditional', condition: { dialect: 'cel', source: `${allowed} && ${pending} && ${notExpired}` }, label: '可以' },
    { id: 'e6', source: 'confirm', target: 'verify', type: 'default' },
    { id: 'e7', source: 'verify', target: 'end', type: 'default' },
  ],
};
