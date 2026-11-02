import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 门户「提交变更申请」（03 §5，04 §3.2，v0.6）：本公司门户管理员在供应商档案上提交关键信息变更（基本信息、地址、
// 银行账户、联系人），flow 代为新建变更单；新建即触发 srm_change_approval，审批与写回沿用 v0.2，发起人（created_by）是
// 门户管理员本人。内部员工照旧在变更单列表直接新建。
//
// 以系统身份运行：门户对变更单只有读共享（ADR-0010 两把锁），新建要靠 flow。所以 flow 进门自己判断「是不是这家供应商的
// 门户管理员」——持 srm_portal_admin 岗位，并且是这家供应商在职联系人上登记的门户账号（与成员键同一份名册）。供应商取自
// 启动记录，但不信任它：伪造别家的 recordId 时名册对不上，直接结束。银行账户、联系人的归属由变更单上的校验规则再把一道关。
// 临时做法：直接触发 flow（REST trigger）不像按钮那样先按启动人的权限读一遍 recordId（objectstack#29050），系统身份的 flow
// 会读到别家的记录，所以名册检查留在 flow 里，平台补上后再评估。谁可以启动另见 objectstack#25481。
const uid = `current_user != null ? current_user.id : ''`;
const allowed = `current_user != null && 'srm_portal_admin' in current_user.positions && supplier != null && membership != null`;
const c = (source: string) => ({ dialect: 'cel' as const, source });
// 屏幕上没填的字段不会绑定成变量，只能用 has(vars.x) 判断（spec FlowVariableSchema 的说明）
const opt = (name: string) => c(`has(vars.${name}) && vars.${name} != null && vars.${name} != '' ? vars.${name} : null`);
const typeIs = (t: string) => `change_type == '${t}'`;

const common = { supplier: cel`supplier.id`, reason: cel`reason`, status: 'in_review' };

export const ChangeSubmitFlow: Automation.Flow = {
  name: 'srm_change_submit',
  label: '提交变更申请',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '变更申请已提交，等待采购审批',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`recordId` }, outputVariable: 'supplier' },
    },
    {
      id: 'load_membership',
      type: 'get_record',
      label: '启动人是这家供应商的门户账号？',
      config: {
        objectName: 'srm_supplier_contact',
        filter: { supplier: cel`recordId`, portal_user: c(uid), active: true },
        outputVariable: 'membership',
      },
    },
    { id: 'gate', type: 'decision', label: '可以提交？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是本公司门户管理员',
      config: { outcome: 'refused', message: '只有本公司的门户管理员可以在门户提交变更申请' },
    },
    {
      id: 'fill',
      type: 'screen',
      label: '填写变更',
      config: {
        title: '提交变更申请：{{ supplier.name }}',
        description: '只填要改的项。提交后由采购审批，银行账户变更还要财务复核；审批通过后系统写回档案。',
        fields: [
          {
            name: 'change_type',
            label: '变更类型',
            type: 'select',
            required: true,
            options: [
              { label: '基本信息', value: 'basic' },
              { label: '注册地址', value: 'address' },
              { label: '银行账户', value: 'bank_account' },
              { label: '联系人', value: 'contact' },
            ],
          },
          { name: 'reason', label: '变更原因', type: 'textarea', required: true },
          // 基本信息：至少填一项（变更单的校验规则 basic_change_not_empty）
          { name: 'new_name', label: '新公司全称', type: 'text', visibleWhen: typeIs('basic') },
          { name: 'new_credit_code', label: '新统一社会信用代码', type: 'text', visibleWhen: typeIs('basic') },
          { name: 'new_registration_no', label: '新注册号 / 税号', type: 'text', visibleWhen: typeIs('basic') },
          { name: 'new_legal_representative', label: '新法定代表人', type: 'text', visibleWhen: typeIs('basic') },
          { name: 'new_registered_capital', label: '新注册资本', type: 'number', min: 0, visibleWhen: typeIs('basic') },
          // 注册地址：国家 / 地区沿用档案（改国家是另一家主体）
          { name: 'address_street', label: '新地址（街道门牌）', type: 'text', required: true, visibleWhen: typeIs('address') },
          { name: 'address_city', label: '城市', type: 'text', required: true, visibleWhen: typeIs('address') },
          { name: 'address_state', label: '省 / 州', type: 'text', visibleWhen: typeIs('address') },
          { name: 'address_postal_code', label: '邮政编码', type: 'text', visibleWhen: typeIs('address') },
          // 银行账户：用一个新账户替换一个有效账户；户名须与公司全称一致（中国供应商）
          { name: 'bank_account', label: '要替换的银行账户', type: 'lookup', reference: 'srm_supplier_bank_account', required: true, visibleWhen: typeIs('bank_account') },
          { name: 'new_bank_name', label: '新开户行', type: 'text', required: true, visibleWhen: typeIs('bank_account') },
          { name: 'new_branch_name', label: '新支行', type: 'text', visibleWhen: typeIs('bank_account') },
          { name: 'new_account_name', label: '新账户名称', type: 'text', required: true, defaultValue: cel`supplier.name`, visibleWhen: typeIs('bank_account') },
          { name: 'new_account_no', label: '新银行账号', type: 'text', required: true, visibleWhen: typeIs('bank_account') },
          { name: 'new_swift_code', label: '新 SWIFT 代码', type: 'text', visibleWhen: typeIs('bank_account') },
          {
            name: 'new_currency',
            label: '新账户币种',
            type: 'select',
            defaultValue: 'cny',
            visibleWhen: typeIs('bank_account'),
            options: [
              { label: '人民币', value: 'cny' },
              { label: '美元', value: 'usd' },
              { label: '欧元', value: 'eur' },
              { label: '日元', value: 'jpy' },
              { label: '港币', value: 'hkd' },
            ],
          },
          // 联系人：改姓名、手机、邮箱
          { name: 'contact', label: '联系人', type: 'lookup', reference: 'srm_supplier_contact', required: true, visibleWhen: typeIs('contact') },
          { name: 'new_contact_name', label: '新姓名', type: 'text', visibleWhen: typeIs('contact') },
          { name: 'new_mobile', label: '新手机', type: 'text', visibleWhen: typeIs('contact') },
          { name: 'new_email', label: '新邮箱', type: 'text', visibleWhen: typeIs('contact') },
        ],
      },
    },
    { id: 'by_type', type: 'decision', label: '按变更类型建单' },
    {
      id: 'create_basic',
      type: 'create_record',
      label: '新建基本信息变更单',
      config: {
        objectName: 'srm_supplier_change_request',
        fields: {
          ...common,
          change_type: 'basic',
          new_name: opt('new_name'),
          new_credit_code: opt('new_credit_code'),
          new_registration_no: opt('new_registration_no'),
          new_legal_representative: opt('new_legal_representative'),
          new_registered_capital: c(`has(vars.new_registered_capital) && vars.new_registered_capital != null ? vars.new_registered_capital : null`),
        },
        outputVariable: 'change',
      },
    },
    {
      id: 'create_address',
      type: 'create_record',
      label: '新建地址变更单',
      config: {
        objectName: 'srm_supplier_change_request',
        fields: {
          ...common,
          change_type: 'address',
          new_address: c(
            `{'street': address_street, 'city': address_city`
              + `, 'state': has(vars.address_state) && vars.address_state != null ? vars.address_state : ''`
              + `, 'postalCode': has(vars.address_postal_code) && vars.address_postal_code != null ? vars.address_postal_code : ''`
              + `, 'country': has(supplier.address) && supplier.address != null && has(supplier.address.country) ? supplier.address.country : 'CN'}`,
          ),
        },
        outputVariable: 'change',
      },
    },
    {
      id: 'create_bank',
      type: 'create_record',
      label: '新建银行账户变更单',
      config: {
        objectName: 'srm_supplier_change_request',
        fields: {
          ...common,
          change_type: 'bank_account',
          bank_account: cel`bank_account`,
          new_bank_name: cel`new_bank_name`,
          new_branch_name: opt('new_branch_name'),
          new_account_name: cel`new_account_name`,
          new_account_no: cel`new_account_no`,
          new_swift_code: opt('new_swift_code'),
          new_currency: c(`has(vars.new_currency) && vars.new_currency != null ? vars.new_currency : 'cny'`),
        },
        outputVariable: 'change',
      },
    },
    {
      id: 'create_contact',
      type: 'create_record',
      label: '新建联系人变更单',
      config: {
        objectName: 'srm_supplier_change_request',
        fields: {
          ...common,
          change_type: 'contact',
          contact: cel`contact`,
          new_contact_name: opt('new_contact_name'),
          new_mobile: opt('new_mobile'),
          new_email: opt('new_email'),
        },
        outputVariable: 'change',
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load_supplier', type: 'default' },
    { id: 'e1', source: 'load_supplier', target: 'load_membership', type: 'default' },
    { id: 'e2', source: 'load_membership', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${allowed})`), label: '不可以' },
    { id: 'e4', source: 'gate', target: 'fill', type: 'conditional', condition: c(allowed), label: '可以' },
    { id: 'e5', source: 'fill', target: 'by_type', type: 'default' },
    { id: 'e6', source: 'by_type', target: 'create_basic', type: 'conditional', condition: c(typeIs('basic')), label: '基本信息' },
    { id: 'e7', source: 'by_type', target: 'create_address', type: 'conditional', condition: c(typeIs('address')), label: '地址' },
    { id: 'e8', source: 'by_type', target: 'create_bank', type: 'conditional', condition: c(typeIs('bank_account')), label: '银行账户' },
    { id: 'e9', source: 'by_type', target: 'create_contact', type: 'conditional', condition: c(typeIs('contact')), label: '联系人' },
    { id: 'e10', source: 'create_basic', target: 'end', type: 'default' },
    { id: 'e11', source: 'create_address', target: 'end', type: 'default' },
    { id: 'e12', source: 'create_bank', target: 'end', type: 'default' },
    { id: 'e13', source: 'create_contact', target: 'end', type: 'default' },
  ],
};
