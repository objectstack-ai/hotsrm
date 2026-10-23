import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier_certificate' };
const columns = [
  { field: 'supplier' },
  { field: 'cert_type' },
  { field: 'cert_no' },
  { field: 'valid_to' },
  { field: 'status' },
  { field: 'verified' },
];

export const SupplierCertificateViews = defineView({
  list: {
    label: '全部证书',
    type: 'grid',
    data,
    columns,
    sort: [{ field: 'valid_to', order: 'asc' }],
  },

  listViews: {
    expiring: {
      label: '即将到期与已过期',
      type: 'grid',
      data,
      columns,
      filter: [{ field: 'status', operator: 'in', value: ['expiring', 'expired'] }],
      sort: [{ field: 'valid_to', order: 'asc' }],
    },
  },
});
