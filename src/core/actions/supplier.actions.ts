import { P } from '@objectstack/spec';
import { defineAction } from '@objectstack/spec/ui';

// 存量导入复核（07 R6）：品类经理核对档案、联系人和证书后确认，供应商移出「存量待复核」视图。
export const ConfirmLegacyReviewAction = defineAction({
  name: 'srm_confirm_legacy_review',
  label: '确认复核',
  objectName: 'srm_supplier',
  icon: 'check-check',
  operation: 'update',
  patch: { legacy_reviewed: true },
  locations: ['record_header', 'list_item'],
  visible: P`record.legacy_imported == true && record.legacy_reviewed != true`,
  confirmText: '确认已核对该供应商的档案、联系人和证书？',
  successMessage: '已确认复核',
  refreshAfter: true,
});
