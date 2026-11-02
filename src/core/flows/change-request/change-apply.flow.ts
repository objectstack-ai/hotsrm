import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 写回信息变更（03 §5）：审批全部通过后由 srm_change_approval 调用，以系统身份把变更单上的新值写回
// 供应商、银行账户或联系人，再把写回后的档案快照到 after_value，变更单置为「已生效」。
// 留空的新值保持原值。银行账户变更：原账户停用（是默认账户的同时取消默认），按新值建一个已核验的
// 有效账户、核验人记为财务复核人，原账户是默认账户的新账户接着做默认（每家至多一个默认账户）。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
const current = (v: string, k: string) => `(has(${v}.${k}) ? ${v}.${k} : null)`;
const filled = (k: string) => `has(req.${k}) && req.${k} != null`;
// 新值填了就用新值，否则保持原值
const text = (newKey: string, v: string, k: string) =>
  cel$(`${filled(newKey)} && !isBlank(req.${newKey}) ? req.${newKey} : ${current(v, k)}`);
const value = (newKey: string, v: string, k: string) => cel$(`${filled(newKey)} ? req.${newKey} : ${current(v, k)}`);
const snapshotOf = (v: string, keys: string[]) => cel$(`{${keys.map((k) => `'${k}': ${current(v, k)}`).join(', ')}}`);

const supplierKeys = ['name', 'credit_code', 'registration_no', 'legal_representative', 'registered_capital', 'address'];

export const ChangeApplyFlow: Automation.Flow = {
  name: 'srm_change_apply',
  label: '写回信息变更',
  type: 'autolaunched',
  status: 'active',
  runAs: 'system',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取变更单',
      config: { objectName: 'srm_supplier_change_request', filter: { id: cel`recordId` }, outputVariable: 'req' },
    },
    { id: 'by_type', type: 'decision', label: '按变更类型写回' },

    // 基本信息 / 地址 → 供应商
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`req.supplier` }, outputVariable: 'supplier' },
    },
    {
      id: 'write_basic',
      type: 'update_record',
      label: '写回基本信息',
      config: {
        objectName: 'srm_supplier',
        filter: { id: cel`req.supplier` },
        fields: {
          name: text('new_name', 'supplier', 'name'),
          credit_code: text('new_credit_code', 'supplier', 'credit_code'),
          registration_no: text('new_registration_no', 'supplier', 'registration_no'),
          legal_representative: text('new_legal_representative', 'supplier', 'legal_representative'),
          registered_capital: value('new_registered_capital', 'supplier', 'registered_capital'),
          last_change_request: cel`req.id`,
        },
      },
    },
    {
      id: 'write_address',
      type: 'update_record',
      label: '写回注册地址',
      config: { objectName: 'srm_supplier', filter: { id: cel`req.supplier` }, fields: { address: cel`req.new_address`, last_change_request: cel`req.id` } },
    },
    {
      id: 'reload_supplier',
      type: 'get_record',
      label: '读取写回后的供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`req.supplier` }, outputVariable: 'after' },
    },
    {
      id: 'done_supplier',
      type: 'update_record',
      label: '变更单已生效',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`req.id` },
        fields: { status: 'applied', applied_at: cel`isoDatetime(now())`, after_value: snapshotOf('after', supplierKeys) },
      },
    },

    // 银行账户：停用原账户，建新的有效账户
    {
      id: 'load_account',
      type: 'get_record',
      label: '读取原银行账户',
      config: { objectName: 'srm_supplier_bank_account', filter: { id: cel`req.bank_account` }, outputVariable: 'old' },
    },
    {
      id: 'retire_account',
      type: 'update_record',
      label: '停用原账户',
      config: {
        objectName: 'srm_supplier_bank_account',
        filter: { id: cel`old.id` },
        fields: { status: 'inactive', is_default: false },
      },
    },
    {
      id: 'create_account',
      type: 'create_record',
      label: '建新的有效账户',
      config: {
        objectName: 'srm_supplier_bank_account',
        fields: {
          supplier: cel`req.supplier`,
          bank_name: cel`req.new_bank_name`,
          branch_name: cel$(current('req', 'new_branch_name')),
          account_name: cel`req.new_account_name`,
          account_no: cel`req.new_account_no`,
          swift_code: cel$(current('req', 'new_swift_code')),
          currency: cel`has(req.new_currency) && req.new_currency != null ? req.new_currency : 'cny'`,
          status: 'active',
          verified_by: cel$(current('req', 'finance_approver')),
          is_default: cel`has(old.is_default) && old.is_default == true`,
        },
        outputVariable: 'created',
      },
    },
    {
      id: 'done_account',
      type: 'update_record',
      label: '变更单已生效',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`req.id` },
        fields: {
          status: 'applied',
          applied_at: cel`isoDatetime(now())`,
          new_bank_account: cel`created.id`,
          after_value: snapshotOf('created', ['id', 'bank_name', 'branch_name', 'account_name', 'swift_code', 'currency', 'status', 'is_default']),
        },
      },
    },

    // 联系人
    {
      id: 'load_contact',
      type: 'get_record',
      label: '读取联系人',
      config: { objectName: 'srm_supplier_contact', filter: { id: cel`req.contact` }, outputVariable: 'contact' },
    },
    {
      id: 'write_contact',
      type: 'update_record',
      label: '写回联系人',
      config: {
        objectName: 'srm_supplier_contact',
        filter: { id: cel`req.contact` },
        fields: {
          name: text('new_contact_name', 'contact', 'name'),
          mobile: text('new_mobile', 'contact', 'mobile'),
          email: text('new_email', 'contact', 'email'),
        },
      },
    },
    {
      id: 'reload_contact',
      type: 'get_record',
      label: '读取写回后的联系人',
      config: { objectName: 'srm_supplier_contact', filter: { id: cel`req.contact` }, outputVariable: 'after' },
    },
    {
      id: 'done_contact',
      type: 'update_record',
      label: '变更单已生效',
      config: {
        objectName: 'srm_supplier_change_request',
        filter: { id: cel`req.id` },
        fields: { status: 'applied', applied_at: cel`isoDatetime(now())`, after_value: snapshotOf('after', ['id', 'name', 'mobile', 'email']) },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'by_type', type: 'default' },
    {
      id: 'e_supplier',
      source: 'by_type',
      target: 'load_supplier',
      type: 'conditional',
      condition: P`req.change_type == 'basic' || req.change_type == 'address'`,
      label: '供应商档案',
    },
    {
      id: 'e_account',
      source: 'by_type',
      target: 'load_account',
      type: 'conditional',
      condition: P`req.change_type == 'bank_account'`,
      label: '银行账户',
    },
    {
      id: 'e_contact',
      source: 'by_type',
      target: 'load_contact',
      type: 'conditional',
      condition: P`req.change_type == 'contact'`,
      label: '联系人',
    },
    { id: 'e_basic', source: 'load_supplier', target: 'write_basic', type: 'conditional', condition: P`req.change_type == 'basic'`, label: '基本信息' },
    { id: 'e_address', source: 'load_supplier', target: 'write_address', type: 'conditional', condition: P`req.change_type == 'address'`, label: '地址' },
    { id: 'e_basic_done', source: 'write_basic', target: 'reload_supplier', type: 'default' },
    { id: 'e_address_done', source: 'write_address', target: 'reload_supplier', type: 'default' },
    { id: 'e_supplier_done', source: 'reload_supplier', target: 'done_supplier', type: 'default' },
    { id: 'e_supplier_end', source: 'done_supplier', target: 'end', type: 'default' },
    { id: 'e_retire', source: 'load_account', target: 'retire_account', type: 'default' },
    { id: 'e_create', source: 'retire_account', target: 'create_account', type: 'default' },
    { id: 'e_account_done', source: 'create_account', target: 'done_account', type: 'default' },
    { id: 'e_account_end', source: 'done_account', target: 'end', type: 'default' },
    { id: 'e_write_contact', source: 'load_contact', target: 'write_contact', type: 'default' },
    { id: 'e_reload_contact', source: 'write_contact', target: 'reload_contact', type: 'default' },
    { id: 'e_contact_done', source: 'reload_contact', target: 'done_contact', type: 'default' },
    { id: 'e_contact_end', source: 'done_contact', target: 'end', type: 'default' },
  ],
};
