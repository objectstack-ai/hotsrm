import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商（02 §4.1、§5.1）。门户岗位、绩效等级等字段随对应版本加入。
export const Supplier = ObjectSchema.create({
  name: 'srm_supplier',
  label: '供应商',
  pluralLabel: '供应商',
  icon: 'factory',
  sharingModel: 'public_read',
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
    status: Field.select({
      label: '状态',
      group: 'qualification',
      defaultValue: 'potential',
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
    erp_vendor_code: Field.text({ label: 'ERP 供应商编码', group: 'registration', unique: true, maxLength: 40 }),
    contact_count: Field.summary({
      label: '联系人数',
      group: 'qualification',
      summaryOperations: { object: 'srm_supplier_contact', field: 'id', function: 'count' },
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
      initialStates: ['potential'],
      transitions: {
        potential: ['qualifying', 'eliminated'],
        qualifying: ['qualified', 'potential'],
        qualified: ['frozen', 'eliminated', 'blacklisted'],
        frozen: ['qualified', 'eliminated', 'blacklisted'],
        eliminated: ['qualifying', 'blacklisted'],
        blacklisted: ['eliminated'],
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
