import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P4 到期提醒（03 §6 第 5 步）：生效中的合同在到期前 60 / 30 / 7 天（params/core.yaml 的 contract_reminder_days，
// 客户改参数时同步这里）各提醒一次，通知合同所有者和主要品类的品类经理。平台按天扫描、每份合同每个提醒日
// 只发一次（time_relative 触发）。
export const ContractExpiryNoticeFlow: Automation.Flow = {
  name: 'srm_contract_expiry_notice',
  label: '合同到期提醒',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '到期前 60 / 30 / 7 天',
      config: {
        timeRelative: { object: 'srm_contract', dateField: 'end_date', offsetDays: [60, 30, 7], filter: { status: 'active' } },
      },
    },
    {
      id: 'load_category',
      type: 'get_record',
      label: '读取主要品类',
      config: {
        objectName: 'srm_category',
        filter: { id: cel`has(record.category) && record.category != null ? record.category : ''` },
        outputVariable: 'category',
      },
    },
    {
      id: 'notify',
      type: 'notify',
      label: '通知所有者和品类经理',
      config: {
        recipients: [
          cel`has(record.owner_id) && record.owner_id != null ? record.owner_id : record.created_by`,
          cel`category != null && has(category.category_manager) ? category.category_manager : null`,
        ],
        title: '合同 {{ record.contract_no }} 将于 {{ record.end_date }} 到期',
        message: '「{{ record.title }}」将于 {{ record.end_date }} 到期，请安排续签或终止。',
        severity: 'warning',
        sourceObject: 'srm_contract',
        sourceId: cel`record.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_category', type: 'default' },
    { id: 'e2', source: 'load_category', target: 'notify', type: 'default' },
    { id: 'e3', source: 'notify', target: 'end', type: 'default' },
  ],
};
