import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 风险事件（02 §4.9，03 §11，FR-903）：品类经理、SQE 手工登记工商、司法、经营等风险；必备证书过期时由
// srm_supplier_qualification_recalc 以系统身份新建「资质」类事件（同一证书有未关闭的事件时不再建），资质恢复后
// 由同一 flow 自动关闭。高风险事件由 srm_risk_event_apply 通知品类经理并生成冻结处置单草稿，回填 disposition。
// 来源现阶段只有 system / manual：外部企业信息服务的自动拉取是客户驱动主题，external_ref 为它预留（按外部编号去重）。
const closed = P`record.status == 'closed'`;

export const RiskEvent = ObjectSchema.create({
  name: 'srm_risk_event',
  label: '风险事件',
  pluralLabel: '风险事件',
  icon: 'siren',
  // 内部全部可读；品类经理、采购主管、SQE、质量经理要能改别人登记的和系统生成的事件，但不能删：OWD public_read +
  // 按岗位授 edit 的共享规则（srm_risk_event_edit_*，objectstack#25470 的裁定写法）。门户不可见（04 §3.2）
  sharingModel: 'public_read',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'event_no',

  fieldGroups: [
    { key: 'event', label: '风险事件', icon: 'siren' },
    { key: 'handling', label: '处理', icon: 'shield-check' },
    { key: 'external', label: '外部系统', icon: 'link' },
  ],

  fields: {
    event_no: Field.autonumber({ label: '事件编号', group: 'event', autonumberFormat: 'RSK{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'event',
      required: true,
      readonlyWhen: P`has(record.id) && record.id != null`,
      relatedListColumns: ['event_no', 'risk_type', 'severity', 'source', 'status', 'disposition', 'created_at'],
    }),
    risk_type: Field.select({ label: '风险类型', group: 'event', required: true, picklist: 'srm_risk_type', readonlyWhen: closed }),
    severity: Field.select({
      label: '严重度',
      group: 'event',
      required: true,
      defaultValue: 'medium',
      readonlyWhen: closed,
      options: [
        { label: '高', value: 'high' },
        { label: '中', value: 'medium' },
        { label: '低', value: 'low' },
      ],
    }),
    // 手工登记一律为 manual；system 只由 flow 写入，external_api 留给外部企业信息服务（客户驱动主题）
    source: Field.select({
      label: '来源',
      group: 'event',
      defaultValue: 'manual',
      readonly: true,
      options: [
        { label: '系统生成', value: 'system' },
        { label: '外部服务', value: 'external_api' },
        { label: '手工登记', value: 'manual' },
      ],
    }),
    // 资质类事件指回触发它的必备证书：同一证书有未关闭的事件时不重复建
    certificate: Field.lookup('srm_supplier_certificate', {
      label: '相关证书',
      group: 'event',
      readonly: true,
      displayField: 'cert_no',
      relatedListColumns: ['event_no', 'severity', 'status', 'created_at'],
    }),
    description: Field.textarea({ label: '事件描述', group: 'event', required: true, maxLength: 4000, readonlyWhen: closed }),

    status: Field.select({
      label: '状态',
      group: 'handling',
      defaultValue: 'open',
      options: [
        { label: '未处理', value: 'open', kind: 'open' },
        { label: '处理中', value: 'mitigating', kind: 'open' },
        { label: '已关闭', value: 'closed', kind: 'won' },
      ],
    }),
    mitigation_plan: Field.textarea({ label: '应对措施', group: 'handling', maxLength: 4000, readonlyWhen: closed }),
    // 关闭时必填（FR-903「处理结论」，requiredWhen 在服务端同样生效）；资质恢复自动关闭时由 flow 写入
    owner_note: Field.textarea({ label: '处理结论', group: 'handling', maxLength: 4000, requiredWhen: closed }),
    // 高风险事件生成的冻结处置单草稿（srm_risk_event_apply 回填）
    disposition: Field.lookup('srm_supplier_disposition', {
      label: '处置单',
      group: 'handling',
      readonly: true,
      relatedListColumns: ['event_no', 'risk_type', 'severity', 'status'],
    }),

    external_ref: Field.text({ label: '外部事件编号', group: 'external', readonly: true, maxLength: 100 }),
  },

  validations: [
    {
      name: 'risk_event_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '风险事件状态不允许这样变更',
      initialStates: ['open'],
      transitions: {
        open: ['mitigating', 'closed'],
        mitigating: ['open', 'closed'],
        // 关错了或风险复现时重新打开
        closed: ['open'],
      },
    },
  ],
});
