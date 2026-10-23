import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 银行账户（02 §4.1，v0.2 M2）。采购侧新建后为「待核验」并锁定，应付会计经「核验银行账户」
// screen flow 置为有效（双人审批，04 §4.2）；有效账户的关键字段只读，修改走信息变更单（v0.2 M4）。
// 收款与付款留在 ERP（ADR-0008），这里只保存账户主数据。
const locked = P`record.status == 'pending_verify' || record.status == 'active' || record.status == 'inactive'`;

export const SupplierBankAccount = ObjectSchema.create({
  name: 'srm_supplier_bank_account',
  label: '银行账户',
  pluralLabel: '银行账户',
  icon: 'landmark',
  nameField: 'account_name',
  sharingModel: 'controlled_by_parent',
  enable: { trackHistory: true },
  stageField: 'status',

  fieldGroups: [
    { key: 'account', label: '账户信息', icon: 'landmark' },
    { key: 'review', label: '状态与核验', icon: 'shield-check' },
  ],

  fields: {
    supplier: Field.masterDetail('srm_supplier', { label: '供应商', required: true, deleteBehavior: 'cascade' }),
    bank_name: Field.text({ label: '开户行', group: 'account', required: true, maxLength: 100, readonlyWhen: locked }),
    branch_name: Field.text({ label: '支行', group: 'account', maxLength: 100, readonlyWhen: locked }),
    account_name: Field.text({ label: '账户名称', group: 'account', required: true, searchable: true, maxLength: 200, readonlyWhen: locked }),
    // BR-20：只有持「查看完整银行账号」能力的岗位（应付会计、供应商管理）能读到完整账号，
    // 其他人读到的是只留后 4 位的脱敏值，也不能按账号筛选或排序
    account_no: Field.text({
      label: '银行账号',
      group: 'account',
      required: true,
      maxLength: 50,
      readonlyWhen: locked,
      maskingRule: 'bank_account',
      requiredPermissions: ['srm_view_bank_account_no'],
    }),
    swift_code: Field.text({ label: 'SWIFT 代码', group: 'account', maxLength: 11, readonlyWhen: locked }),
    currency: Field.select({
      label: '币种',
      group: 'account',
      required: true,
      defaultValue: 'cny',
      readonlyWhen: locked,
      options: [
        { label: '人民币', value: 'cny' },
        { label: '美元', value: 'usd' },
        { label: '欧元', value: 'eur' },
        { label: '日元', value: 'jpy' },
        { label: '港币', value: 'hkd' },
      ],
    }),
    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'pending_verify',
      readonly: true,
      options: [
        { label: '待核验', value: 'pending_verify', kind: 'open' },
        { label: '有效', value: 'active', kind: 'won' },
        { label: '停用', value: 'inactive', kind: 'lost' },
      ],
    }),
    verified_by: Field.user({ label: '核验人', group: 'review', readonly: true }),
    is_default: Field.boolean({
      label: '默认账户',
      group: 'account',
      defaultValue: false,
    }),
    erp_bank_id: Field.text({ label: 'ERP 银行账户 ID', group: 'review', maxLength: 50, readonly: true }),
  },

  validations: [
    {
      name: 'bank_account_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '银行账户状态不允许这样变更',
      // 用户新建一律是 pending_verify（status 只读，写入的值被丢弃）；active 留给信息变更单 flow
      // 以系统身份直接建出已审批的新账户（03 §5，v0.2 M4）
      initialStates: ['pending_verify', 'active'],
      transitions: {
        pending_verify: ['active'],
        active: ['inactive'],
        inactive: ['active'],
      },
    },
    {
      // 户名与供应商全称一致，防止付款给第三方；境外账户的户名常用英文名，不校验
      name: 'account_name_matches_supplier',
      type: 'script',
      severity: 'error',
      message: '账户名称必须与供应商全称一致',
      condition: P`has(record.supplier.country) && record.supplier.country == 'cn' && has(record.supplier.name) && record.account_name != record.supplier.name`,
    },
    {
      // 只有核验通过的账户能设为默认（新建和修改都由这条拦住）。不用 readonlyWhen：信息变更单 flow 停用原账户时
      // 要同时取消默认，readonlyWhen 对系统身份的写入同样生效
      name: 'default_account_active',
      type: 'script',
      severity: 'error',
      message: '只有「有效」的银行账户可以设为默认账户',
      condition: P`record.is_default == true && record.status != 'active'`,
    },
    {
      // 每家供应商至多一个默认账户：供应商上的 default_bank_account_count 是本条写入前的计数
      name: 'single_default_account',
      type: 'script',
      severity: 'error',
      message: '这家供应商已有默认账户，请先取消原默认账户',
      condition: P`record.is_default == true && (!has(previous.is_default) || previous.is_default != true) && has(record.supplier.default_bank_account_count) && record.supplier.default_bank_account_count > 0`,
    },
  ],
});
