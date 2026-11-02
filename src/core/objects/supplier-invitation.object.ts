import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 门户邀请（02 §4.2，04 §3.3，v0.6）：品类经理、采购主管提出的门户开通需求，记录邀请的业务信息和进度。
// 组织邀请本身由组织管理员在成员页发（flow 发不了，07 §6.2 V3），门户访问由组织管理员运行「开通门户」写入联系人的
// portal_user 后才生效（ADR-0010）。所以邀请必须指向已登记的供应商和联系人：门户用户只能经名册看到数据，没有供应商
// 档案就无法隔离。邀请按供应商状态分两类：潜在、淘汰的供应商是准入邀请（新公司先登记为潜在供应商，唯一约束查重），
// 必填申请品类，开通后在门户提交准入申请；准入中、合格、冻结的供应商只开通门户，不填品类；黑名单不得邀请。
// 状态、过期日、开通结果只由 flow 写：srm_invitation_send 补邮箱与过期日并通知组织管理员，srm_portal_enable 开通，
// srm_invitation_expire_sweep 过期，处置执行、准入未通过、联系人停用时撤销。门户不可见（04 §3.2）。
// 建好后供应商和联系人不再改：邀请邮箱、开通期限按新建时的联系人写入，要换人另建一张邀请
const created = P`has(record.id) && record.id != null`;

export const SupplierInvitation = ObjectSchema.create({
  name: 'srm_supplier_invitation',
  label: '门户邀请',
  pluralLabel: '门户邀请',
  icon: 'mail-plus',
  sharingModel: 'private',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'invitation_no',

  fieldGroups: [
    { key: 'invitation', label: '邀请信息', icon: 'mail-plus' },
    { key: 'progress', label: '开通进度', icon: 'key-round' },
  ],

  fields: {
    invitation_no: Field.autonumber({ label: '邀请编号', group: 'invitation', autonumberFormat: 'INV{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', { label: '供应商', group: 'invitation', required: true, readonlyWhen: created }),
    contact: Field.lookup('srm_supplier_contact', { label: '联系人', group: 'invitation', required: true, readonlyWhen: created }),
    // 新建时由 srm_invitation_send 从联系人复制：组织管理员按它在成员页发邀请
    contact_email: Field.email({ label: '邀请邮箱', group: 'invitation', readonly: true }),
    // 准入邀请填申请品类：潜在或淘汰的供应商开通门户后，按这些品类在门户提交准入申请（source = invited）
    categories: {
      type: 'lookup',
      label: '申请品类',
      group: 'invitation',
      reference: 'srm_category',
      multiple: true,
    },
    // 门户管理员按人授权（GL-10 6.3.1 c、6.4.3）：要供应商盖章的授权书，开通时再任命到 srm_portal_admin
    portal_admin: Field.boolean({ label: '授予门户管理员', group: 'invitation', defaultValue: false }),
    admin_authorization: Field.file({
      label: '门户管理员授权书',
      group: 'invitation',
      requiredWhen: P`record.portal_admin == true`,
      visibleWhen: P`record.portal_admin == true`,
    }),
    notes: Field.textarea({ label: '说明', group: 'invitation' }),
    status: Field.select({
      label: '状态',
      group: 'progress',
      readonly: true,
      defaultValue: 'sent',
      options: [
        // 已发给组织管理员，等对方接受组织邀请后开通
        { label: '已发送', value: 'sent', kind: 'open' },
        { label: '已开通', value: 'accepted', kind: 'won' },
        { label: '已过期', value: 'expired', kind: 'lost' },
        { label: '已撤销', value: 'revoked', kind: 'lost' },
      ],
    }),
    expires_on: Field.date({ label: '开通期限', group: 'progress', readonly: true }),
    portal_user: Field.user({ label: '门户账号', group: 'progress', readonly: true }),
    enabled_by: Field.user({ label: '开通人', group: 'progress', readonly: true }),
    enabled_at: Field.datetime({ label: '开通时间', group: 'progress', readonly: true }),
    // 供应商在门户提交准入申请后由 srm_application_submit 回填
    application: Field.lookup('srm_supplier_application', { label: '准入申请', group: 'progress', readonly: true }),
  },

  validations: [
    {
      name: 'invitation_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '门户邀请状态不允许这样变更',
      initialStates: ['sent'],
      transitions: {
        sent: ['accepted', 'expired', 'revoked'],
        accepted: ['revoked'],
      },
    },
    {
      name: 'invitation_contact_of_supplier',
      type: 'script',
      severity: 'error',
      message: '联系人必须属于这家供应商',
      condition: P`has(record.contact.supplier) && record.contact.supplier != record.supplier`,
    },
    {
      name: 'invitation_contact_active',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只能邀请在职的联系人',
      condition: P`has(record.contact.active) && record.contact.active != true`,
    },
    {
      name: 'invitation_contact_not_enabled',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '这位联系人已开通门户账号',
      condition: P`has(record.contact.portal_user) && record.contact.portal_user != null`,
    },
    {
      // 黑名单供应商不得开通门户（BR-02）；淘汰的供应商可以为重新准入邀请（FR-208）
      name: 'invitation_supplier_not_blacklisted',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '黑名单供应商不能开通门户',
      condition: P`has(record.supplier.status) && record.supplier.status == 'blacklisted'`,
    },
    {
      // 准入邀请（潜在、淘汰的供应商）必填申请品类：供应商开通后按这些品类提交准入申请
      name: 'invitation_categories_required',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '「潜在」或「淘汰」状态的供应商是准入邀请，请填写申请品类',
      condition: P`has(record.supplier.status) && (record.supplier.status == 'potential' || record.supplier.status == 'eliminated') && !(has(record.categories) && record.categories != null && size(record.categories) > 0)`,
    },
    {
      // 申请品类只用于准入：已在准入中或已合格的供应商只开通门户，不再提交申请
      name: 'invitation_categories_for_admission',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '只有「潜在」或「淘汰」状态的供应商邀请时填申请品类',
      condition: P`has(record.categories) && record.categories != null && size(record.categories) > 0 && has(record.supplier.status) && record.supplier.status != 'potential' && record.supplier.status != 'eliminated'`,
    },
  ],
});
