import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P7 步骤 1（03 §8，FR-602，BR-15）：交付记录写入时检验结论为不合格、严重度为严重或主要，自动开一张整改单。
// 新建和修改都看（月度导入是 upsert，第二遍导入可能把「合格」改成「不合格」），只在「变成」主要 / 严重不合格时开单；
// 同一条交付记录已有整改单时不再开，重复导入不重复开单（03 §2.3 R2）。次要不合格只计入绩效，不开单。
// 负责 SQE 取物料品类的 SQE；品类没有 SQE 时通知质量经理指派。期限由整改单字段的默认值按参数算好。
// 供应商 quality 联系人的通知等 objectstack#25444 或 v0.6 门户上线后再加。
const qualifying = (r: string) => `${r}.inspection_result == 'fail' && (${r}.severity == 'critical' || ${r}.severity == 'major')`;

export const ScarCreateFlow: Automation.Flow = {
  name: 'srm_scar_create',
  label: '不合格交付开整改单',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '交付记录主要 / 严重不合格',
      config: {
        objectName: 'srm_delivery_record',
        triggerType: 'record-after-write',
        condition: {
          dialect: 'cel',
          source: `${qualifying('record')} && (previous == null || !(${qualifying('previous')}))`,
        },
      },
    },
    {
      id: 'find_existing',
      type: 'get_record',
      label: '已有整改单？',
      config: { objectName: 'srm_quality_issue', filter: { delivery_record: cel`record.id` }, outputVariable: 'existing' },
    },
    { id: 'already', type: 'decision', label: '已开过单？' },
    {
      id: 'load_material',
      type: 'get_record',
      label: '读取物料',
      config: { objectName: 'srm_material', filter: { id: cel`record.material` }, outputVariable: 'material' },
    },
    {
      id: 'load_category',
      type: 'get_record',
      label: '读取物料品类',
      config: {
        objectName: 'srm_category',
        filter: { id: cel`material != null && has(material.category) && material.category != null ? material.category : ''` },
        outputVariable: 'category',
      },
    },
    {
      id: 'create_issue',
      type: 'create_record',
      label: '新建整改单',
      config: {
        objectName: 'srm_quality_issue',
        fields: {
          supplier: cel`record.supplier`,
          material: cel`record.material`,
          delivery_record: cel`record.id`,
          source: 'iqc',
          severity: cel`record.severity`,
          problem_description: {
            dialect: 'cel',
            source:
              `'交付记录 ' + record.erp_receipt_no + '（订单 ' + record.erp_order_no + ' 行 ' + record.erp_line_no + '，实到 ' + string(record.receipt_date) + '）来料检验不合格'`
              + ` + (has(record.defect_quantity) && record.defect_quantity != null ? '，不良数 ' + string(record.defect_quantity) : '')`
              + ` + (has(record.defect_description) && record.defect_description != null && !isBlank(record.defect_description) ? '：' + record.defect_description : '')`,
          },
          sqe: cel`category != null && has(category.sqe) ? category.sqe : null`,
        },
        outputVariable: 'issue',
      },
    },
    {
      id: 'load_quality_managers',
      type: 'get_record',
      label: '读取质量经理',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_quality_manager' }, limit: 50, outputVariable: 'qualityManagers' },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_new',
              type: 'notify',
              label: '通知 SQE（没有 SQE 时通知质量经理）',
              config: {
                recipients: cel`category != null && has(category.sqe) && category.sqe != null ? [category.sqe] : qualityManagers.map(p, p.user_id)`,
                title: '新整改单：{{ record.erp_receipt_no }} 来料检验不合格',
                message: '交付记录（订单 {{ record.erp_order_no }} 行 {{ record.erp_line_no }}）检验不合格，已自动开出整改单。请联系供应商在期限内提交临时措施（D3）；品类没有 SQE 时请质量经理指派。',
                severity: 'warning',
                sourceObject: 'srm_quality_issue',
                sourceId: cel`issue.id`,
              },
            },
          ],
        },
        // 没有可通知的人（品类没有 SQE、也没有质量经理）时不影响开单
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_existing', type: 'default' },
    { id: 'e2', source: 'find_existing', target: 'already', type: 'default' },
    { id: 'e_dup', source: 'already', target: 'end', type: 'conditional', condition: P`existing != null`, label: '已有' },
    { id: 'e_new', source: 'already', target: 'load_material', type: 'conditional', condition: P`existing == null`, label: '没有' },
    { id: 'e3', source: 'load_material', target: 'load_category', type: 'default' },
    { id: 'e4', source: 'load_category', target: 'create_issue', type: 'default' },
    { id: 'e5', source: 'create_issue', target: 'load_quality_managers', type: 'default' },
    { id: 'e6', source: 'load_quality_managers', target: 'notify_guard', type: 'default' },
    { id: 'e7', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
