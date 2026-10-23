import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_bank_account' };
const columns = [
  { field: 'supplier' },
  { field: 'account_name' },
  { field: 'bank_name' },
  { field: 'account_no' },
  { field: 'currency' },
  { field: 'status' },
  { field: 'is_default' },
];

export const SupplierBankAccountViews = defineView({
  list: {
    label: '全部银行账户',
    type: 'grid',
    data,
    columns,
  },

  listViews: {
    pending_verify: {
      label: '待核验',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'equals', value: 'pending_verify' }],
    },
  },
});
