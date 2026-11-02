import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 新建银行账户待核验通知（03 §5，v0.6）：v0.6 起门户管理员也能在门户新建银行账户，应付会计不再总是事先知道，
// 所以账户以「待核验」新建时通知全部应付会计，到账户上点「核验」（srm_bank_verify，双人原则照旧）。
// 通知里不写账号：通知没有脱敏规则（BR-20）。
export const BankPendingNoticeFlow: Automation.Flow = {
  name: 'srm_bank_pending_notice',
  label: '银行账户待核验通知',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '新建待核验的银行账户',
      config: {
        objectName: 'srm_supplier_bank_account',
        triggerType: 'record-after-create',
        condition: P`record.status == 'pending_verify'`,
      },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'supplier' },
    },
    {
      id: 'load_accountants',
      type: 'get_record',
      label: '读取应付会计',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_ap_accountant' }, limit: 50, outputVariable: 'accountants' },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_accountants',
              type: 'notify',
              label: '通知应付会计核验',
              config: {
                recipients: cel`accountants.map(p, p.user_id)`,
                title: '{{ supplier.name }} 新建了银行账户，待核验',
                message: '开户行：{{ record.bank_name }} {{ record.branch_name }}。请按银行账户核实方式确认账户属实后，在账户上点「核验」；新建人不能核验自己建的账户。',
                severity: 'info',
                sourceObject: 'srm_supplier_bank_account',
                sourceId: cel`record.id`,
              },
            },
          ],
        },
        // 环境里还没有任命应付会计时不影响新建
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_supplier', type: 'default' },
    { id: 'e2', source: 'load_supplier', target: 'load_accountants', type: 'default' },
    { id: 'e3', source: 'load_accountants', target: 'notify_guard', type: 'default' },
    { id: 'e4', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
