import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { CertTypePicklist } from '../../picklists/cert-type.picklist.js';

// P10 资质异常与恢复（03 §11，FR-902）：证书状态、「必备」标志或「已核验」变化后重新计算供应商的 qualification_alert。
// 一张证书「顶得住」它的类型 = 同类型里有一张未过期（有效或即将到期）且已核验的证书。
// - 标记：有一张过期的必备证书，而同类型没有顶得住的证书；
// - 解除：每一张过期或未核验的必备证书，同类型都有顶得住的证书（即每一种必备资质类型都有未过期且已核验的证书）；
// - 两样都不满足时保持原值：门户改了一张有效证书（复位为未核验）不会因此新标资质异常，但已有的异常要等 SQE 核验后才解除，
//   门户上传新证书、把过期证书的有效期改长都解不了（v0.6，「经 SQE 核验才解除」）。
// 内部录入或修改的证书由 srm_certificate_change_check 直接记为已核验，所以内部续期、补录照旧即时生效。
// v0.5 起联动风险事件（03 §11）：这张证书是必备证书且刚变为已过期时，新建一条系统来源的「资质」类风险事件
// （这张证书已有未关闭的事件时不再建）；资质异常解除时，关闭该供应商未关闭的系统资质事件并写处理结论。
const expiredMandatory = `record.is_mandatory == true && record.status == 'expired'`;
const covered = (c: string) => `certs.exists(d, d.cert_type == ${c}.cert_type && d.status != 'expired' && d.verified == true)`;
const raise = `certs.exists(c, c.is_mandatory == true && c.status == 'expired' && !${covered('c')})`;
const clear = `!certs.exists(c, c.is_mandatory == true && (c.status == 'expired' || c.verified != true) && !${covered('c')})`;
// 事件描述里写资质类型的中文名；扩展包追加的类型不在表里，写选项值
const certTypeLabels = `{${CertTypePicklist.options.map((o) => `'${o.value}': '${o.label}'`).join(', ')}}`;
const certTypeLabel = `(record.cert_type in ${certTypeLabels} ? ${certTypeLabels}[record.cert_type] : record.cert_type)`;
export const QualificationRecalcFlow: Automation.Flow = {
  name: 'srm_supplier_qualification_recalc',
  label: '资质异常重算',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '证书状态变化',
      config: {
        objectName: 'srm_supplier_certificate',
        triggerType: 'record-after-update',
        condition: P`(has(record.status) && has(previous.status) && record.status != previous.status)
          || (has(record.is_mandatory) && has(previous.is_mandatory) && record.is_mandatory != previous.is_mandatory)
          || (has(record.verified) && has(previous.verified) && record.verified != previous.verified)`,
      },
    },
    {
      id: 'load_certs',
      type: 'get_record',
      label: '读取该供应商的全部证书',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { supplier: cel`record.supplier` },
        fields: ['cert_type', 'is_mandatory', 'status', 'verified'],
        limit: 500,
        outputVariable: 'certs',
      },
    },
    { id: 'check', type: 'decision', label: '标记、解除还是保持？' },
    {
      id: 'raise_alert',
      type: 'update_record',
      label: '标记资质异常',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { qualification_alert: true } },
    },
    { id: 'this_expired', type: 'decision', label: '这张必备证书刚过期？' },
    {
      id: 'find_open_event',
      type: 'get_record',
      label: '这张证书已有未关闭的风险事件？',
      config: {
        objectName: 'srm_risk_event',
        filter: { certificate: cel`record.id`, status: { $ne: 'closed' } },
        outputVariable: 'openEvent',
      },
    },
    { id: 'has_event', type: 'decision', label: '已有事件？' },
    {
      id: 'create_event',
      type: 'create_record',
      label: '新建资质风险事件',
      config: {
        objectName: 'srm_risk_event',
        fields: {
          supplier: cel`record.supplier`,
          risk_type: 'qualification',
          severity: 'medium',
          source: 'system',
          certificate: cel`record.id`,
          description: {
            dialect: 'cel',
            source:
              `'必备资质证书' + (has(record.cert_no) && record.cert_no != null && !isBlank(record.cert_no) ? ' ' + record.cert_no : '')`
              + ` + '（' + ${certTypeLabel} + '）已过期' + (has(record.valid_to) && record.valid_to != null ? '，有效期至 ' + string(record.valid_to) : '')`
              + ` + '。补齐有效证书后资质异常解除，本事件自动关闭。'`,
          },
        },
        outputVariable: 'riskEvent',
      },
    },
    {
      id: 'clear_alert',
      type: 'update_record',
      label: '解除资质异常',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { qualification_alert: false } },
    },
    {
      id: 'close_events',
      type: 'update_record',
      label: '关闭系统生成的资质风险事件',
      config: {
        objectName: 'srm_risk_event',
        filter: { supplier: cel`record.supplier`, risk_type: 'qualification', source: 'system', status: { $ne: 'closed' } },
        multi: true,
        fields: { status: 'closed', owner_note: '必备资质已恢复，资质异常解除，系统自动关闭。' },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_certs', type: 'default' },
    { id: 'e2', source: 'load_certs', target: 'check', type: 'default' },
    { id: 'e3', source: 'check', target: 'raise_alert', type: 'conditional', condition: { dialect: 'cel', source: raise }, label: '标记' },
    { id: 'e4', source: 'check', target: 'clear_alert', type: 'conditional', condition: { dialect: 'cel', source: clear }, label: '解除' },
    { id: 'e4a', source: 'check', target: 'end', type: 'conditional', condition: { dialect: 'cel', source: `!(${raise}) && !(${clear})` }, label: '保持' },
    { id: 'e5', source: 'raise_alert', target: 'this_expired', type: 'default' },
    { id: 'e5a', source: 'this_expired', target: 'find_open_event', type: 'conditional', condition: { dialect: 'cel', source: expiredMandatory }, label: '是' },
    { id: 'e5b', source: 'this_expired', target: 'end', type: 'conditional', condition: { dialect: 'cel', source: `!(${expiredMandatory})` }, label: '不是' },
    { id: 'e5c', source: 'find_open_event', target: 'has_event', type: 'default' },
    { id: 'e5d', source: 'has_event', target: 'end', type: 'conditional', condition: P`openEvent != null`, label: '已有' },
    { id: 'e5e', source: 'has_event', target: 'create_event', type: 'conditional', condition: P`openEvent == null`, label: '没有' },
    { id: 'e5f', source: 'create_event', target: 'end', type: 'default' },
    { id: 'e6', source: 'clear_alert', target: 'close_events', type: 'default' },
    { id: 'e7', source: 'close_events', target: 'end', type: 'default' },
  ],
};
