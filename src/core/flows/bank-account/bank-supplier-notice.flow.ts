import type * as Automation from '@objectstack/spec/automation';
import { loadPortalAdmins, loadRoster, loadVendor, notifySupplier, pathOf, portalAdmins, vendorName } from '../portal/supplier-notice.js';

// 银行账户核验结果通知供应商（05 §5「银行账户与变更单结果」，v0.6 U6）：待核验的账户由应付会计核验为有效
// （srm_bank_verify），或经银行账户变更单生效时，发给该供应商名册上的门户管理员（银行账户由门户管理员维护，04 §3.2）。
// 通知里只写开户行，不写账号（05 §5）。
const SOURCE = 'srm_supplier_bank_account';

export const BankSupplierNoticeFlow: Automation.Flow = {
  name: 'srm_bank_supplier_notice',
  label: '银行账户核验通知供应商',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '账户由待核验变为有效',
      config: {
        objectName: SOURCE,
        triggerType: 'record-after-update',
        condition: { dialect: 'cel', source: `record.status == 'active' && has(previous.status) && previous.status == 'pending_verify'` },
      },
    },
    loadRoster('record.supplier'),
    loadPortalAdmins(),
    loadVendor('record.supplier'),
    notifySupplier('notify_admins', '通知供应商门户管理员：账户已核验', {
      recipients: portalAdmins,
      template: 'srm_bank_account_verified',
      data: { supplier: vendorName, bank: 'record.bank_name', path: pathOf(SOURCE, 'record.id') },
      sourceObject: SOURCE,
      sourceId: 'record.id',
    }),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_roster', type: 'default' },
    { id: 'e2', source: 'load_roster', target: 'load_portal_admins', type: 'default' },
    { id: 'e3', source: 'load_portal_admins', target: 'load_vendor', type: 'default' },
    { id: 'e4', source: 'load_vendor', target: 'notify_admins_guard', type: 'default' },
    { id: 'e5', source: 'notify_admins_guard', target: 'end', type: 'default' },
  ],
};
