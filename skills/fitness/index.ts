/**
 * 健身追踪技能入口
 *
 * 重新导出 src/tools/fitness-tracker.ts 中的健身管理功能。
 */
export {
  calculateBmr,
  calculateMacroSplit,
  generateFatLossPlan,
  getFitnessProfile,
  upsertFitnessProfile,
  addMeal,
  getMeals,
  deleteMeal,
  addWorkout,
  getWorkouts,
  deleteWorkout,
  updateHydration,
  updateSleep,
  getDailyLog,
  getDailySummary,
  getWeeklyTrend,
  updateDailyNotes,
  getRecentWorkouts,
  getRecentMeals,
} from "../../src/tools/fitness-tracker.js";

export type {
  FitnessGender,
  ActivityLevel,
  MealType,
  WorkoutType,
  Intensity,
  FitnessProfile,
  FitnessDailyLog,
  FitnessWorkout,
  FitnessMeal,
  MacroSplit,
  DailySummary,
} from "../../src/tools/fitness-tracker.js";
