import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 黑名单禁入期满提醒（02 §4.1，03 §5，FR-208）：黑名单供应商的禁入期满日（拉黑日期 + params/core.yaml 的
// blacklist_years）前 30 天和当天各提醒一次，通知拉黑处置单的发起人和供应商各品类的品类经理。只提醒：
// 期满不自动解除，是否解除由品类经理评估后发起「解除黑名单」处置单，按 03 §12 审批。
// 平台按天扫描、每家供应商每个提醒日只发一次（time_relative 触发）。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });

export const BlacklistExpiryNoticeFlow: Automation.Flow = {
  name: 'srm_blacklist_expiry_notice',
  label: '黑名单禁入期满提醒',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '禁入期满前 30 天和当天',
      config: {
        timeRelative: { object: 'srm_supplier', dateField: 'blacklist_until', offsetDays: [30, 0], filter: { status: 'blacklisted' } },
      },
    },
    {
      id: 'load_disposition',
      type: 'get_record',
      label: '读取拉黑处置单',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`has(record.blacklist_disposition) && record.blacklist_disposition != null ? record.blacklist_disposition : ''` },
        outputVariable: 'disp',
      },
    },
    {
      id: 'load_qualifications',
      type: 'get_record',
      label: '读取品类资格',
      config: { objectName: 'srm_supplier_category', filter: { supplier: cel`record.id` }, limit: 200, outputVariable: 'qualifications' },
    },
    {
      id: 'load_categories',
      type: 'get_record',
      label: '读取品类',
      config: { objectName: 'srm_category', filter: { id: { $in: cel`qualifications.map(q, q.category)` } }, limit: 200, outputVariable: 'categories' },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify',
              type: 'notify',
              label: '通知发起人和品类经理',
              config: {
                recipients: [
                  cel$(`disp != null ? (has(disp.submitted_by) && disp.submitted_by != null ? disp.submitted_by : disp.created_by) : null`),
                  cel`categories.filter(c, has(c.category_manager) && c.category_manager != null).map(c, c.category_manager)`,
                ],
                title: '黑名单供应商 {{ record.name }} 的禁入期将于 {{ record.blacklist_until }} 届满',
                message: '{{ record.name }} 于 {{ record.blacklisted_on }} 拉入黑名单，禁入期至 {{ record.blacklist_until }}。期满不会自动解除；如需解除，请评估后发起「解除黑名单」处置单审批。',
                severity: 'info',
                sourceObject: 'srm_supplier',
                sourceId: cel`record.id`,
              },
            },
          ],
        },
        // 没有可通知的人（处置单发起人已不在、品类没有品类经理）时跳过
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_disposition', type: 'default' },
    { id: 'e2', source: 'load_disposition', target: 'load_qualifications', type: 'default' },
    { id: 'e3', source: 'load_qualifications', target: 'load_categories', type: 'default' },
    { id: 'e4', source: 'load_categories', target: 'notify_guard', type: 'default' },
    { id: 'e5', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
