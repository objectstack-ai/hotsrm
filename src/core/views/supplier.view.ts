import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_supplier' };

export const SupplierViews = defineView({
  list: {
    label: '全部供应商',
    type: 'grid',
    data,
    columns: [
      { field: 'supplier_no' },
      { field: 'name' },
      { field: 'country' },
      { field: 'supplier_type' },
      { field: 'status' },
      { field: 'qualification_alert' },
      { field: 'risk_level' },
    ],
    sort: [{ field: 'supplier_no', order: 'desc' }],
  },

  listViews: {
    qualification_alert: {
      label: '资质异常',
      type: 'grid',
      data,
      columns: [{ field: 'supplier_no' }, { field: 'name' }, { field: 'status' }, { field: 'expired_certificate_count' }],
      filter: [{ field: 'qualification_alert', operator: 'equals', value: true }],
    },
    // 存量导入、待复核（07 R6）：核对档案、联系人与证书后点「确认复核」移出本视图
    legacy_review: {
      label: '存量待复核',
      type: 'grid',
      data,
      columns: [
        { field: 'supplier_no' },
        { field: 'name' },
        { field: 'country' },
        { field: 'status' },
        { field: 'contact_count' },
        { field: 'qualification_alert' },
      ],
      filter: [
        { field: 'legacy_imported', operator: 'equals', value: true },
        { field: 'legacy_reviewed', operator: 'equals', value: false },
      ],
      sort: [{ field: 'supplier_no', order: 'asc' }],
    },
    // 黑名单名录（FR-208，v0.5）：拉黑日期、原因、处置单与禁入期满日；期满前提醒，解除仍走处置单审批
    blacklist: {
      label: '黑名单名录',
      type: 'grid',
      data,
      columns: [
        { field: 'supplier_no' },
        { field: 'name' },
        { field: 'country' },
        { field: 'blacklisted_on' },
        { field: 'blacklist_until' },
        { field: 'blacklist_reason' },
        { field: 'blacklist_disposition' },
      ],
      filter: [{ field: 'status', operator: 'equals', value: 'blacklisted' }],
      sort: [{ field: 'blacklisted_on', order: 'desc' }],
    },
    // 有未关闭风险事件的供应商（v0.5）
    open_risk: {
      label: '有未关闭风险',
      type: 'grid',
      data,
      columns: [{ field: 'supplier_no' }, { field: 'name' }, { field: 'status' }, { field: 'open_risk_event_count' }, { field: 'qualification_alert' }],
      filter: [{ field: 'open_risk_event_count', operator: 'greater_than', value: 0 }],
    },
    // 优选供应商（03 §10 第 6 步，v0.5）：最近一期绩效 A 级，供寻源邀请参考（v0.7）
    preferred: {
      label: '优选供应商',
      type: 'grid',
      data,
      columns: [{ field: 'supplier_no' }, { field: 'name' }, { field: 'status' }, { field: 'grade' }, { field: 'latest_score' }],
      filter: [{ field: 'preferred', operator: 'equals', value: true }],
      sort: [{ field: 'latest_score', order: 'desc' }],
    },
    // 同一批导入里的两位主联系人校验规则拦不住（objectstack#25477），在这里人工处理
    primary_contact_conflict: {
      label: '主联系人重复',
      type: 'grid',
      data,
      columns: [{ field: 'supplier_no' }, { field: 'name' }, { field: 'primary_contact_count' }, { field: 'contact_count' }],
      filter: [{ field: 'primary_contact_count', operator: 'greater_than', value: 1 }],
    },
  },
});
