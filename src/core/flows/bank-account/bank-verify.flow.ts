import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 核验银行账户（03 §13 screen flow，04 §4.2，BR-20）：采购侧新建的账户为「待核验」并锁定，
// 应付会计按 params/core.yaml 的 bank_change_verification 核实后在这里确认，账户置为「有效」。
// 双人审批：新建人不能核验自己建的账户。以系统身份运行，因为状态和核验人对所有人只读；
// 进门的检查都在 flow 里做（只有应付会计、只核验待核验的账户、不能是新建人）。
// 临时做法：平台还不能在 flow 上声明谁可以启动（objectstack#25481），任何成员都能经 trigger 入口
// 启动系统身份的 screen flow，所以岗位检查只能写在 flow 里读 current_user.positions；平台支持后改为声明。
export const BankVerifyFlow: Automation.Flow = {
  name: 'srm_bank_verify',
  label: '核验银行账户',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '银行账户已核验，状态为有效',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取银行账户',
      config: { objectName: 'srm_supplier_bank_account', filter: { id: cel`recordId` }, outputVariable: 'account' },
    },
    { id: 'gate', type: 'decision', label: '可以核验？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是应付会计',
      config: { outcome: 'refused', message: '只有应付会计可以核验银行账户' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是待核验',
      config: { outcome: 'refused', message: '只有「待核验」的银行账户需要核验' },
    },
    {
      id: 'refuse_self',
      type: 'end',
      label: '新建人不能核验',
      config: { outcome: 'refused', message: '新建人不能核验自己建的银行账户，请由另一位应付会计核验' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '核对账户',
      config: {
        title: '核验银行账户：{{ account.account_name }}',
        description:
          '开户行：{{ account.bank_name }} {{ account.branch_name }}\n银行账号：{{ account.account_no }}\n'
          + '请先通过对公账户验证或向供应商法定代表人电话核实等方式确认账户属实，再确认核验。',
        waitForInput: true,
      },
    },
    {
      id: 'activate',
      type: 'update_record',
      label: '置为有效',
      config: {
        objectName: 'srm_supplier_bank_account',
        filter: { id: cel`account.id` },
        fields: { status: 'active', verified_by: cel`current_user.id` },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'gate', type: 'default' },
    {
      id: 'e2',
      source: 'gate',
      target: 'refuse_position',
      type: 'conditional',
      condition: P`current_user == null || !('srm_ap_accountant' in current_user.positions)`,
      label: '不是应付会计',
    },
    {
      id: 'e3',
      source: 'gate',
      target: 'refuse_status',
      type: 'conditional',
      condition: P`current_user != null && 'srm_ap_accountant' in current_user.positions && (account == null || account.status != 'pending_verify')`,
      label: '不是待核验',
    },
    {
      id: 'e4',
      source: 'gate',
      target: 'refuse_self',
      type: 'conditional',
      condition: P`current_user != null && 'srm_ap_accountant' in current_user.positions && account != null && account.status == 'pending_verify' && account.created_by == current_user.id`,
      label: '是新建人',
    },
    {
      id: 'e5',
      source: 'gate',
      target: 'confirm',
      type: 'conditional',
      condition: P`current_user != null && 'srm_ap_accountant' in current_user.positions && account != null && account.status == 'pending_verify' && account.created_by != current_user.id`,
      label: '可以',
    },
    { id: 'e6', source: 'confirm', target: 'activate', type: 'default' },
    { id: 'e7', source: 'activate', target: 'end', type: 'default' },
  ],
};
