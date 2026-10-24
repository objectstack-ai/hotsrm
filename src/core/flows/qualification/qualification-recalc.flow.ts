import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { CertTypePicklist } from '../../picklists/cert-type.picklist.js';

// P10 资质异常与恢复（03 §11，FR-902）：证书状态或「必备」标志变化后重新计算供应商的
// qualification_alert——还有任何一张必备证书已过期就为 true，否则为 false。
// v0.1 由内部人员维护证书，暂不要求「经 SQE 核验」才解除；门户版本（v0.6）加上 verified 条件。
// v0.5 起联动风险事件（03 §11）：这张证书是必备证书且刚变为已过期时，新建一条系统来源的「资质」类风险事件
// （这张证书已有未关闭的事件时不再建）；资质异常解除时，关闭该供应商未关闭的系统资质事件并写处理结论。
const expiredMandatory = `record.is_mandatory == true && record.status == 'expired'`;
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
          || (has(record.is_mandatory) && has(previous.is_mandatory) && record.is_mandatory != previous.is_mandatory)`,
      },
    },
    {
      id: 'find_expired_mandatory',
      type: 'get_record',
      label: '找一张已过期的必备证书',
      config: {
        objectName: 'srm_supplier_certificate',
        filter: { supplier: cel`record.supplier`, is_mandatory: true, status: 'expired' },
        outputVariable: 'expiredMandatory',
      },
    },
    { id: 'check', type: 'decision', label: '还有过期的必备证书？' },
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
    { id: 'e1', source: 'start', target: 'find_expired_mandatory', type: 'default' },
    { id: 'e2', source: 'find_expired_mandatory', target: 'check', type: 'default' },
    { id: 'e3', source: 'check', target: 'raise_alert', type: 'conditional', condition: P`expiredMandatory != null`, label: '有' },
    { id: 'e4', source: 'check', target: 'clear_alert', type: 'conditional', condition: P`expiredMandatory == null`, label: '没有' },
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
