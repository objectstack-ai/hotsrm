import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 资质证书（02 §4.1）。status 与 verified 由 flow 维护（资质扫描、核验证书）。
export const SupplierCertificate = ObjectSchema.create({
  name: 'srm_supplier_certificate',
  label: '资质证书',
  pluralLabel: '资质证书',
  icon: 'badge-check',
  nameField: 'cert_type',
  sharingModel: 'controlled_by_parent',

  fieldGroups: [
    { key: 'certificate', label: '证书信息', icon: 'badge-check' },
    { key: 'review', label: '状态与核验', icon: 'shield-check' },
  ],

  fields: {
    supplier: Field.masterDetail('srm_supplier', { label: '供应商', required: true, deleteBehavior: 'cascade' }),
    cert_type: Field.select({ label: '资质类型', group: 'certificate', required: true, picklist: 'srm_cert_type' }),
    is_mandatory: Field.boolean({ label: '必备资质', group: 'review', defaultValue: false }),
    // 存量导入按「供应商 + 资质类型 + 证书编号」匹配，所以导入的证书必须有编号
    cert_no: Field.text({
      label: '证书编号',
      group: 'certificate',
      maxLength: 100,
      requiredWhen: P`record.legacy_imported == true`,
    }),
    issuer: Field.text({ label: '发证机构', group: 'certificate', maxLength: 200 }),
    valid_from: Field.date({ label: '生效日期', group: 'certificate' }),
    valid_to: Field.date({ label: '有效期至', group: 'certificate' }),
    // 表格导入带不了文件：存量导入的证书先不要求扫描件，复核时补传
    attachment: Field.file({
      label: '扫描件',
      group: 'certificate',
      requiredWhen: P`record.legacy_imported != true`,
    }),
    status: Field.select({
      label: '状态',
      group: 'review',
      defaultValue: 'valid',
      options: [
        { label: '有效', value: 'valid' },
        { label: '即将到期', value: 'expiring' },
        { label: '已过期', value: 'expired' },
      ],
    }),
    verified: Field.boolean({ label: '已核验', group: 'review', defaultValue: false }),
    legacy_imported: Field.boolean({
      label: '存量导入',
      group: 'review',
      defaultValue: false,
      readonlyWhen: P`previous.legacy_imported != true`,
    }),
  },

  validations: [
    {
      name: 'valid_to_after_valid_from',
      type: 'script',
      severity: 'error',
      message: '有效期至不能早于生效日期',
      condition: P`has(record.valid_from) && has(record.valid_to) && record.valid_from != null && record.valid_to != null && !isBlank(record.valid_from) && !isBlank(record.valid_to) && record.valid_to < record.valid_from`,
    },
  ],
});
