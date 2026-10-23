import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 银行账户详情页的「核验」按钮，启动 srm_bank_verify（03 §13）。谁能核验由 flow 自己检查。
export const BankVerifyAction = defineAction({
  name: 'srm_bank_verify',
  label: '核验',
  objectName: 'srm_supplier_bank_account',
  icon: 'shield-check',
  type: 'flow',
  target: 'srm_bank_verify',
  locations: ['record_header', 'list_item'],
  visible: P`record.status == 'pending_verify'`,
  refreshAfter: true,
});
