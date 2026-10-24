// 绩效评分、分级与申诉用到的参数（params/core.yaml，示例值）。flow 里不能读参数文件，客户改参数时同步这里；
// 测试逐项核对与 params/core.yaml 一致（同 generate.flow.ts 的 CYCLE）。

// perf_grade_min：等级下限分，A ≥ 90、B ≥ 80、C ≥ 70，其余 D（03 §10 第 4 步）
export const GRADE_MIN = { A: 90, B: 80, C: 70 } as const;
// perf_score_days：转人工评分起的评分期限（日历日）
export const SCORE_DAYS = 10;
// perf_missing_score：截止后未评项的默认分（FR-703）
export const MISSING_SCORE = 60;
// perf_appeal_days：发布后可以申诉的天数（FR-706）
export const APPEAL_DAYS = 7;
// 截止前几天提醒还有未评项的评分人
export const SCORE_REMINDER_DAYS = 3;

// 按总分定等级的 CEL（总分已保留两位小数）
export const gradeOf = (total: string) =>
  `(${total} >= ${GRADE_MIN.A}.0 ? 'grade_a' : ${total} >= ${GRADE_MIN.B}.0 ? 'grade_b' : ${total} >= ${GRADE_MIN.C}.0 ? 'grade_c' : 'grade_d')`;
