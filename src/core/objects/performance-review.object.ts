import { ObjectSchema, Field } from '@objectstack/spec/data';

// 绩效考评单（02 §4.7、§5.7，03 §10，FR-702）：srm_performance_generate 每期为活跃供应商生成（calculating），按启用
// 指标建评分明细并快照权重，从交付记录算出 OTD、批次合格率、PPM 与对应得分后转人工评分（scoring）。本期没有交付记录、
// 某项自动指标没有数据时标记「数据不全」，该项不给分（07 R7）。v0.5 P3：评分人经「提交评分」打分，截止后缺评取默认分
// （srm_score_overdue_sweep）→ 审定中：srm_performance_publish 汇总分级并交采购总监审定，通过即发布并回写供应商等级，
// 驳回即退回重评 → 发布后可代录申诉一次（srm_appeal_submit），采购总监处理（srm_appeal_resolve）后回到已发布。
// 全部字段由 flow 写入，对用户只读。
// 同一供应商同一期间只有一张考评单（唯一索引兜底，flow 先查后建，重复运行不重复建）。
// 门户上线（v0.6）时加 portal_position，供应商只看本公司已发布的考评单（04 §3）。
export const PerformanceReview = ObjectSchema.create({
  name: 'srm_performance_review',
  label: '绩效考评单',
  pluralLabel: '绩效考评单',
  icon: 'award',
  // 内部只读（04 §2.3）：考评单只由 flow 生成和推进，评分只经「提交评分」screen flow
  sharingModel: 'public_read',
  enable: { trackHistory: true },
  stageField: 'status',
  nameField: 'review_no',

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'award' },
    { key: 'metrics', label: '自动指标', icon: 'calculator' },
    { key: 'scores', label: '得分与等级', icon: 'star' },
    { key: 'appeal', label: '申诉', icon: 'message-square' },
  ],

  fields: {
    review_no: Field.autonumber({ label: '考评单号', group: 'basic', autonumberFormat: 'PR{YYYY}{00000}' }),
    supplier: Field.lookup('srm_supplier', {
      label: '供应商',
      group: 'basic',
      required: true,
      readonly: true,
      relatedListColumns: ['review_no', 'period', 'cycle', 'total_score', 'grade', 'status', 'data_incomplete'],
    }),
    // 按供应商所供最高物资类别取参数 perf_cycle（03 §10 第 1 步）
    cycle: Field.select({
      label: '考评周期',
      group: 'basic',
      required: true,
      readonly: true,
      options: [
        { label: '月度', value: 'monthly' },
        { label: '季度', value: 'quarterly' },
        { label: '年度', value: 'yearly' },
      ],
    }),
    // 月度 2026-10、季度 2026Q3、年度 2026
    period: Field.text({ label: '考评期间', group: 'basic', required: true, readonly: true, maxLength: 10 }),
    period_start: Field.date({ label: '期间开始', group: 'basic', readonly: true }),
    period_end: Field.date({ label: '期间结束', group: 'basic', readonly: true }),
    status: Field.select({
      label: '状态',
      group: 'basic',
      required: true,
      defaultValue: 'calculating',
      options: [
        { label: '自动算分', value: 'calculating', kind: 'open' },
        { label: '人工评分', value: 'scoring', kind: 'open' },
        { label: '审定中', value: 'reviewing', kind: 'open' },
        { label: '申诉中', value: 'appealed', kind: 'open' },
        { label: '已发布', value: 'published', kind: 'won' },
        { label: '已作废', value: 'void', kind: 'lost' },
      ],
    }),
    // 本期没有交付记录或某项自动指标没有数据（07 R7）：该项不给零分，留给人工评分环节处理
    data_incomplete: Field.boolean({ label: '数据不全', group: 'basic', defaultValue: false, readonly: true }),
    // 评分截止日：转人工评分时为当天 + perf_score_days；退回重评时重新起算（03 §10 第 3、5 步）
    score_due: Field.date({ label: '评分截止日', group: 'basic', readonly: true }),
    void_reason: Field.textarea({ label: '作废理由', group: 'basic', readonly: true, maxLength: 2000 }),

    // 交付记录按期汇总（05 §4.1，口径同数据集 srm_delivery_metrics）；没有数据的项为空
    otd_rate: Field.percent({ label: '交付准时率', group: 'metrics', readonly: true, scale: 2 }),
    lot_pass_rate: Field.percent({ label: '批次合格率', group: 'metrics', readonly: true, scale: 2 }),
    ppm: Field.number({ label: 'PPM', group: 'metrics', readonly: true, scale: 0 }),
    // ERP 集成前为空
    ack_on_time_rate: Field.percent({ label: '订单响应及时率', group: 'metrics', readonly: true, scale: 2 }),
    delivery_count: Field.number({ label: '交付行数', group: 'metrics', readonly: true, scale: 0 }),

    // 各维度得分与总分由汇总分级写入（03 §10 第 4 步，v0.5 P3），存储字段供看板使用
    quality_score: Field.number({ label: '质量得分', group: 'scores', readonly: true, scale: 2 }),
    cost_score: Field.number({ label: '成本得分', group: 'scores', readonly: true, scale: 2 }),
    delivery_score: Field.number({ label: '交付得分', group: 'scores', readonly: true, scale: 2 }),
    service_score: Field.number({ label: '服务得分', group: 'scores', readonly: true, scale: 2 }),
    hse_score: Field.number({ label: '安全环保得分', group: 'scores', readonly: true, scale: 2 }),
    total_score: Field.number({ label: '总分', group: 'scores', readonly: true, scale: 2 }),
    // 选项值至少两个字符，所以是 grade_a 而不是 a
    grade: Field.select({
      label: '等级',
      group: 'scores',
      readonly: true,
      options: [
        { label: 'A', value: 'grade_a' },
        { label: 'B', value: 'grade_b' },
        { label: 'C', value: 'grade_c' },
        { label: 'D', value: 'grade_d' },
      ],
    }),

    // 审定发布（03 §10 第 5 步）：审批节点写审批结论，flow 写审定人、意见和发布日期
    approval_status: Field.select({
      label: '审批结论',
      group: 'scores',
      readonly: true,
      options: [
        { label: '审批中', value: 'pending' },
        { label: '已批准', value: 'approved' },
        { label: '已驳回', value: 'rejected' },
        { label: '退回修改', value: 'returned' },
        { label: '已撤回', value: 'recalled' },
      ],
    }),
    reviewer: Field.user({ label: '审定人', group: 'scores', readonly: true }),
    review_comment: Field.textarea({ label: '审定意见', group: 'scores', readonly: true, maxLength: 2000 }),
    published_date: Field.date({ label: '发布日期', group: 'scores', readonly: true }),

    // 申诉（03 §10 第 7 步，FR-706）：发布后 perf_appeal_days 内一次；v0.6 前由采购代录
    appeal_reason: Field.textarea({ label: '申诉理由', group: 'appeal', readonly: true, maxLength: 2000 }),
    appeal_date: Field.date({ label: '申诉日期', group: 'appeal', readonly: true }),
    appeal_recorded_by: Field.user({ label: '申诉代录人', group: 'appeal', readonly: true }),
    appeal_result: Field.textarea({ label: '申诉处理结果', group: 'appeal', readonly: true, maxLength: 2000 }),
    appeal_outcome: Field.select({
      label: '申诉结论',
      group: 'appeal',
      readonly: true,
      options: [
        { label: '维持原结果', value: 'maintained' },
        { label: '调整总分', value: 'adjusted' },
      ],
    }),
    appeal_handled_by: Field.user({ label: '申诉处理人', group: 'appeal', readonly: true }),
  },

  indexes: [{ name: 'srm_performance_review_period', fields: ['supplier', 'period'], unique: 'organization' }],

  validations: [
    {
      name: 'review_status_flow',
      type: 'state_machine',
      field: 'status',
      message: '考评单状态不允许这样变更',
      initialStates: ['calculating'],
      transitions: {
        calculating: ['scoring', 'void'],
        scoring: ['reviewing', 'void'],
        // 采购总监驳回即退回重评（03 §10 第 5 步）
        reviewing: ['published', 'scoring', 'void'],
        published: ['appealed'],
        appealed: ['published'],
        void: [],
      },
    },
  ],
});
