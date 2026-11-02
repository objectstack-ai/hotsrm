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
    // 存量导入的证书没有扫描件，复核时补传
    legacy_missing_attachment: {
      label: '存量导入缺扫描件',
      type: 'grid',
      data,
      columns,
      filter: [
        { field: 'legacy_imported', operator: 'equals', value: true },
        { field: 'attachment', operator: 'is_empty' },
      ],
      sort: [{ field: 'supplier', order: 'asc' }],
    },
  },
});
