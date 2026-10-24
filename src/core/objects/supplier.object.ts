import { P, cel } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商（02 §4.1、§5.1）。门户岗位、绩效等级等字段随对应版本加入。
// 关键信息在准入期间可以直接改；准入通过后只能经信息变更单修改（03 §5，FR-207）：
// srm_change_apply 写回时同时写只读字段 last_change_request，校验规则 key_info_via_change_request
// 只放行带着它的修改。不用 readonlyWhen：它连系统身份的写入也挡（flow 写不回去）。
const keyInfoFields = ['name', 'country', 'credit_code', 'registration_no', 'legal_representative', 'registered_capital', 'address'];
const changed = (k: string) => `(has(record.${k}) ? record.${k} : null) != (has(previous.${k}) ? previous.${k} : null)`;

export const Supplier = ObjectSchema.create({
  name: 'srm_supplier',
  label: '供应商',
  pluralLabel: '供应商',
  icon: 'factory',
  // 临时：目标是 public_read。品类经理要能改别人建的供应商（含存量导入的），平台的 modifyAllRecords
  // 会连删除一起放开，只能先放宽 OWD；能改哪些字段由权限集的 allowEdit 与 FLS 决定（objectstack#25470，02 §4.1）。
  sharingModel: 'public_read_write',
  enable: { trackHistory: true },
  stageField: 'status',

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'building' },
    { key: 'registration', label: '工商与税务', icon: 'landmark' },
    { key: 'qualification', label: '准入与资质', icon: 'shield-check' },
  ],

  fields: {
    supplier_no: Field.autonumber({ label: '供应商编号', group: 'basic', autonumberFormat: 'SUP{0000000}' }),
    name: Field.text({ label: '公司全称', group: 'basic', required: true, searchable: true, maxLength: 200 }),
    short_name: Field.text({ label: '简称', group: 'basic', searchable: true, maxLength: 50 }),
    country: Field.select({ label: '国家 / 地区', group: 'basic', required: true, defaultValue: 'cn', picklist: 'srm_country' }),
    // 境内按统一社会信用代码、境外按「国家 / 地区 + 注册号」查重（BR-01，ADR-0007）
    credit_code: Field.text({
      label: '统一社会信用代码',
      group: 'registration',
      unique: true,
      maxLength: 18,
      requiredWhen: P`record.country == 'cn'`,
      visibleWhen: P`record.country == 'cn'`,
    }),
    registration_no: Field.text({
      label: '注册号 / 税号',
      group: 'registration',
      maxLength: 50,
      requiredWhen: P`record.country != 'cn'`,
      visibleWhen: P`record.country != 'cn'`,
    }),
    supplier_type: Field.select({
      label: '供应商类型',
      group: 'basic',
      options: [
        { label: '生产商', value: 'manufacturer' },
        { label: '代理分销', value: 'distributor' },
        { label: '服务商', value: 'service' },
        { label: '物流商', value: 'logistics' },
      ],
    }),
    // 新建供应商从「潜在」开始走准入；存量导入的供应商已在用，直接为「合格」（02 §5.1）。
    // 用默认值而不是导入表格里的状态列：重复导入时不带状态，不会把冻结、淘汰改回合格。
    status: Field.select({
      label: '状态',
      group: 'qualification',
      defaultValue: cel`has(record.legacy_imported) && record.legacy_imported == true ? 'qualified' : 'potential'`,
      options: [
        { label: '潜在', value: 'potential', kind: 'open' },
        { label: '准入中', value: 'qualifying', kind: 'open' },
        { label: '合格', value: 'qualified', kind: 'won' },
        { label: '冻结', value: 'frozen', kind: 'lost' },
        { label: '淘汰', value: 'eliminated', kind: 'lost' },
        { label: '黑名单', value: 'blacklisted', kind: 'lost' },
      ],
    }),
    // 不是状态：不改变是否合格，只阻止新的寻源邀请（BR-04），由资质扫描 flow 维护
    qualification_alert: Field.boolean({ label: '资质异常', group: 'qualification', defaultValue: false }),
    risk_level: Field.select({
      label: '风险等级',
      group: 'qualification',
      options: [
        { label: '低', value: 'low' },
        { label: '中', value: 'medium' },
        { label: '高', value: 'high' },
      ],
    }),
    registered_capital: Field.currency({ label: '注册资本', group: 'registration' }),
    established_date: Field.date({ label: '成立日期', group: 'registration' }),
    legal_representative: Field.text({ label: '法定代表人', group: 'registration', maxLength: 50 }),
    taxpayer_type: Field.select({
      label: '纳税人类型',
      group: 'registration',
      options: [
        { label: '一般纳税人', value: 'general' },
        { label: '小规模纳税人', value: 'small_scale' },
        { label: '境外', value: 'overseas' },
      ],
    }),
    address: Field.address({ label: '注册地址', group: 'basic' }),
    website: Field.url({ label: '网站', group: 'basic' }),
    is_related_party: Field.boolean({ label: '关联方', group: 'qualification', defaultValue: false }),
    // 有生效中的质量协议 / 廉洁协议时为 true，由 srm_contract_agreement_recalc 维护（02 §4.1，v0.3）
    quality_agreement_signed: Field.boolean({ label: '已签质量协议', group: 'qualification', defaultValue: false }),
    integrity_agreement_signed: Field.boolean({ label: '已签廉洁协议', group: 'qualification', defaultValue: false }),
    // 存量导入（07 R6）：只能在新建时置为 true；已建档的供应商重复导入时该列被忽略（readonlyWhen）
    legacy_imported: Field.boolean({
      label: '存量导入',
      group: 'qualification',
      defaultValue: false,
      readonlyWhen: P`previous.legacy_imported != true`,
    }),
    legacy_reviewed: Field.boolean({ label: '存量已复核', group: 'qualification', defaultValue: false }),
    // 最近一次写回本档案的信息变更单，由 srm_change_apply 写入（v0.2）
    last_change_request: Field.lookup('srm_supplier_change_request', { label: '最近变更单', group: 'registration', readonly: true }),
    erp_vendor_code: Field.text({ label: 'ERP 供应商编码', group: 'registration', unique: true, maxLength: 40 }),
    contact_count: Field.summary({
      label: '联系人数',
      group: 'qualification',
      summaryOperations: { object: 'srm_supplier_contact', field: 'id', function: 'count' },
    }),
    // 「每家至多一位主联系人」的守卫依据（联系人校验规则读它）
    primary_contact_count: Field.summary({
      label: '主联系人数',
      group: 'qualification',
      summaryOperations: {
        object: 'srm_supplier_contact',
        field: 'id',
        function: 'count',
        filter: { is_primary: true },
      },
    }),
    expired_certificate_count: Field.summary({
      label: '过期证书数',
      group: 'qualification',
      summaryOperations: {
        object: 'srm_supplier_certificate',
        field: 'id',
        function: 'count',
        filter: { status: 'expired' },
      },
    }),
    // 「同一家供应商同时只能有一张审批中的处置单」的守卫依据（处置单校验规则读它，v0.3）
    open_disposition_count: Field.summary({
      label: '审批中处置单数',
      group: 'qualification',
      summaryOperations: {
        object: 'srm_supplier_disposition',
        field: 'id',
        function: 'count',
        filter: { status: 'in_review' },
      },
    }),
    // 银行账户「每家至多一个默认账户」的校验读这个计数（v0.2）
    default_bank_account_count: Field.summary({
      label: '默认银行账户数',
      group: 'qualification',
      summaryOperations: {
        object: 'srm_supplier_bank_account',
        field: 'id',
        function: 'count',
        filter: { is_default: true },
      },
    }),
  },

  indexes: [
    { name: 'srm_supplier_overseas_identity', fields: ['country', 'registration_no'], unique: 'organization' },
  ],

  validations: [
    {
      name: 'supplier_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '供应商状态不允许这样变更',
      initialStates: ['potential', 'qualified'],
      transitions: {
        potential: ['qualifying', 'eliminated'],
        // 淘汰后重新准入未通过时回到淘汰（03 §3 步骤 8）
        qualifying: ['qualified', 'potential', 'eliminated'],
        qualified: ['frozen', 'eliminated', 'blacklisted'],
        frozen: ['qualified', 'eliminated', 'blacklisted'],
        eliminated: ['qualifying', 'blacklisted'],
        blacklisted: ['eliminated'],
      },
    },
    {
      name: 'initial_status_by_source',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '新建供应商须从「潜在」开始准入；只有存量导入的供应商建档即为「合格」',
      condition: P`(record.legacy_imported == true) != (record.status == 'qualified')`,
    },
    {
      name: 'key_info_via_change_request',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '合格供应商的全称、国家 / 地区、信用代码、注册号、法定代表人、注册资本、注册地址请经信息变更单修改',
      condition: {
        dialect: 'cel',
        source:
          `previous.status != 'potential' && previous.status != 'qualifying' && `
          + `${changed('last_change_request')} == false && (${keyInfoFields.map(changed).join(' || ')})`,
      },
    },
    {
      name: 'credit_code_format',
      type: 'script',
      severity: 'error',
      message: '统一社会信用代码应为 18 位数字或大写字母',
      condition: P`has(record.credit_code) && record.credit_code != null && !isBlank(record.credit_code) && !record.credit_code.matches('^[0-9A-Z]{18}$')`,
    },
  ],
});
