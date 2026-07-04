/**
 * 健身追踪模块
 *
 * 提供体成分分析、宏量营养素配比（30/35/35）、有氧+力量训练记录、
 * 睡眠与水分追踪的完整功能集。
 *
 * 配比说明（按减脂方向）：
 *   - 蛋白质供能 30% ：保护瘦体重，较高食物热效应
 *   - 碳水化合物供能 35% ：提供训练能量，不过低碳水
 *   - 脂肪供能 35% ：必需脂肪酸，维持激素水平
 */

import { db } from "../db/conversation-store.js";
import { logger } from "../logger.js";

// ── 类型定义 ───────────────────────────────────────────────────

export type FitnessGender = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type MealType = "breakfast" | "lunch" | "dinner" | "snack";
export type WorkoutType = "cardio" | "strength" | "mixed";
export type Intensity = "low" | "moderate" | "high";

export interface FitnessProfile {
  ownerId: string;
  bmr: number;
  calorieTarget: number;
  proteinTargetG: number;
  carbsTargetG: number;
  fatTargetG: number;
  weightKg?: number;
  heightCm?: number;
  age?: number;
  gender?: FitnessGender;
  activityLevel: ActivityLevel;
  createdAt: string;
  updatedAt: string;
}

export interface FitnessDailyLog {
  id: number;
  ownerId: string;
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number;
  sleepHours: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface FitnessWorkout {
  id: number;
  ownerId: string;
  date: string;
  type: WorkoutType;
  durationMinutes: number;
  details: string;
  intensity: Intensity;
  createdAt: string;
}

export interface FitnessMeal {
  id: number;
  ownerId: string;
  date: string;
  mealType: MealType;
  foodName: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  createdAt: string;
}

export interface MacroSplit {
  proteinG: number;
  carbsG: number;
  fatG: number;
  proteinCal: number;
  carbsCal: number;
  fatCal: number;
  totalCal: number;
}

export interface DailySummary {
  date: string;
  calories: number;
  macros: { protein: number; carbs: number; fat: number };
  waterMl: number;
  sleepHours: number;
  workouts: FitnessWorkout[];
  meals: FitnessMeal[];
  remainingCalories: number;
  macroProgress: { proteinPct: number; carbsPct: number; fatPct: number };
}

// ── 工具常量 ───────────────────────────────────────────────────

const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_CARBS = 4;
const KCAL_PER_G_FAT = 9;

const PROTEIN_RATIO = 0.30;
const CARBS_RATIO = 0.35;
const FAT_RATIO = 0.35;

/** 活动系数（Mifflin-St Jeor × 系数） */
const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// ── BMR 计算 ───────────────────────────────────────────────────

/**
 * Mifflin-St Jeor 基础代谢率公式
 *
 * 男性：10 × 体重(kg) + 6.25 × 身高(cm) - 5 × 年龄 + 5
 * 女性：10 × 体重(kg) + 6.25 × 身高(cm) - 5 × 年龄 - 161
 */
export function calculateBmr(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: FitnessGender
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === "male" ? base + 5 : base - 161);
}

/**
 * 根据 BMR 和活动系数计算维持热量
 */
export function calculateMaintenanceCalories(
  bmr: number,
  activityLevel: ActivityLevel
): number {
  return Math.round(bmr * ACTIVITY_MULTIPLIER[activityLevel]);
}

/**
 * 根据目标热量计算 30/35/35 宏量营养素配比
 */
export function calculateMacroSplit(totalCalories: number): MacroSplit {
  const proteinCal = Math.round(totalCalories * PROTEIN_RATIO);
  const carbsCal = Math.round(totalCalories * CARBS_RATIO);
  const fatCal = Math.round(totalCalories * FAT_RATIO);

  return {
    proteinG: Math.round(proteinCal / KCAL_PER_G_PROTEIN),
    carbsG: Math.round(carbsCal / KCAL_PER_G_CARBS),
    fatG: Math.round(fatCal / KCAL_PER_G_FAT),
    proteinCal,
    carbsCal,
    fatCal,
    totalCal: proteinCal + carbsCal + fatCal,
  };
}

/**
 * 一键生成减脂方案：BMR → 热量目标 → 宏量营养素
 *
 * @param weightKg 体重 (kg)
 * @param heightCm 身高 (cm)
 * @param age 年龄
 * @param gender 性别
 * @param activityLevel 活动水平
 * @param deficitCal 热量缺口（默认 300，减脂期常用 200-500）
 */
export function generateFatLossPlan(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: FitnessGender,
  activityLevel: ActivityLevel = "sedentary",
  deficitCal = 300
): {
  bmr: number;
  maintenanceCalories: number;
  targetCalories: number;
  macros: MacroSplit;
} {
  const bmr = calculateBmr(weightKg, heightCm, age, gender);
  const maintenanceCalories = calculateMaintenanceCalories(bmr, activityLevel);
  // 减脂踩 BMR 线吃，不叠加活动消耗
  const targetCalories = bmr;
  const macros = calculateMacroSplit(targetCalories);

  return { bmr, maintenanceCalories, targetCalories, macros };
}

// ── 数据库操作 ─────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── 用户配置 ───────────────────────────────────────────────────

export function getFitnessProfile(ownerId: string): FitnessProfile | null {
  const row = db
    .prepare("SELECT * FROM fitness_profile WHERE owner_id = ?")
    .get(ownerId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    ownerId: row.owner_id as string,
    bmr: row.bmr as number,
    calorieTarget: row.calorie_target as number,
    proteinTargetG: row.protein_target_g as number,
    carbsTargetG: row.carbs_target_g as number,
    fatTargetG: row.fat_target_g as number,
    weightKg: row.weight_kg as number | undefined,
    heightCm: row.height_cm as number | undefined,
    age: row.age as number | undefined,
    gender: row.gender as FitnessGender | undefined,
    activityLevel: row.activity_level as ActivityLevel,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function upsertFitnessProfile(
  ownerId: string,
  data: {
    weightKg?: number;
    heightCm?: number;
    age?: number;
    gender?: FitnessGender;
    activityLevel?: ActivityLevel;
    calorieTarget?: number;
  }
): FitnessProfile {
  const existing = getFitnessProfile(ownerId);
  const timestamp = now();

  const weightKg = data.weightKg ?? existing?.weightKg;
  const heightCm = data.heightCm ?? existing?.heightCm;
  const age = data.age ?? existing?.age;
  const gender = data.gender ?? existing?.gender;
  const activityLevel = data.activityLevel ?? existing?.activityLevel ?? "sedentary";

  // 有足够数据时自动计算 BMR 和热量目标
  let bmr = existing?.bmr ?? 0;
  let calorieTarget = data.calorieTarget ?? existing?.calorieTarget ?? 0;

  if (weightKg && heightCm && age && gender) {
    bmr = calculateBmr(weightKg, heightCm, age, gender);
    if (!data.calorieTarget || calorieTarget === 0) {
      calorieTarget = bmr;
    }
  }

  const macros = calculateMacroSplit(calorieTarget);

  db.prepare(
    `
    INSERT INTO fitness_profile (
      owner_id, bmr, calorie_target,
      protein_target_g, carbs_target_g, fat_target_g,
      weight_kg, height_cm, age, gender, activity_level,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET
      bmr = excluded.bmr,
      calorie_target = excluded.calorie_target,
      protein_target_g = excluded.protein_target_g,
      carbs_target_g = excluded.carbs_target_g,
      fat_target_g = excluded.fat_target_g,
      weight_kg = excluded.weight_kg,
      height_cm = excluded.height_cm,
      age = excluded.age,
      gender = excluded.gender,
      activity_level = excluded.activity_level,
      updated_at = excluded.updated_at
    `
  ).run(
    ownerId, bmr, calorieTarget,
    macros.proteinG, macros.carbsG, macros.fatG,
    weightKg ?? null, heightCm ?? null, age ?? null, gender ?? null, activityLevel,
    timestamp, timestamp
  );

  return getFitnessProfile(ownerId)!;
}

// ── 日常饮食记录 ───────────────────────────────────────────────

export function addMeal(
  ownerId: string,
  date: string,
  mealType: MealType,
  foodName: string,
  calories: number,
  proteinG = 0,
  carbsG = 0,
  fatG = 0
): FitnessMeal {
  const timestamp = now();
  const result = db.prepare(
    `
    INSERT INTO fitness_meals (owner_id, date, meal_type, food_name, calories, protein_g, carbs_g, fat_g, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(ownerId, date, mealType, foodName, calories, proteinG, carbsG, fatG, timestamp);

  // 同步更新当日汇总
  syncDailyLog(ownerId, date);

  return {
    id: result.lastInsertRowid as number,
    ownerId,
    date,
    mealType,
    foodName,
    calories,
    proteinG,
    carbsG,
    fatG,
    createdAt: timestamp,
  };
}

export function getMeals(ownerId: string, date: string): FitnessMeal[] {
  const rows = db
    .prepare(
      "SELECT * FROM fitness_meals WHERE owner_id = ? AND date = ? ORDER BY created_at ASC"
    )
    .all(ownerId, date) as Array<Record<string, unknown>>;

  return rows.map(mapMealRow);
}

export function deleteMeal(mealId: number, ownerId: string): boolean {
  const meal = db
    .prepare("SELECT owner_id, date FROM fitness_meals WHERE id = ?")
    .get(mealId) as { owner_id: string; date: string } | undefined;
  if (!meal || meal.owner_id !== ownerId) return false;

  db.prepare("DELETE FROM fitness_meals WHERE id = ?").run(mealId);
  syncDailyLog(ownerId, meal.date);
  return true;
}

// ── 运动记录 ───────────────────────────────────────────────────

export function addWorkout(
  ownerId: string,
  date: string,
  type: WorkoutType,
  durationMinutes: number,
  details = "",
  intensity: Intensity = "moderate"
): FitnessWorkout {
  const timestamp = now();
  const result = db.prepare(
    `
    INSERT INTO fitness_workouts (owner_id, date, type, duration_minutes, details, intensity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(ownerId, date, type, durationMinutes, details, intensity, timestamp);

  return {
    id: result.lastInsertRowid as number,
    ownerId,
    date,
    type,
    durationMinutes,
    details,
    intensity,
    createdAt: timestamp,
  };
}

export function getWorkouts(ownerId: string, date: string): FitnessWorkout[] {
  const rows = db
    .prepare(
      "SELECT * FROM fitness_workouts WHERE owner_id = ? AND date = ? ORDER BY created_at ASC"
    )
    .all(ownerId, date) as Array<Record<string, unknown>>;

  return rows.map(mapWorkoutRow);
}

export function deleteWorkout(workoutId: number, ownerId: string): boolean {
  const row = db
    .prepare("SELECT owner_id FROM fitness_workouts WHERE id = ?")
    .get(workoutId) as { owner_id: string } | undefined;
  if (!row || row.owner_id !== ownerId) return false;

  db.prepare("DELETE FROM fitness_workouts WHERE id = ?").run(workoutId);
  return true;
}

// ── 水分与睡眠 ─────────────────────────────────────────────────

export function updateHydration(
  ownerId: string,
  date: string,
  waterMl: number
): FitnessDailyLog {
  db.prepare(
    `
    INSERT INTO fitness_daily (owner_id, date, water_ml, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      water_ml = excluded.water_ml,
      updated_at = excluded.updated_at
    `
  ).run(ownerId, date, waterMl, now(), now());

  return getDailyLog(ownerId, date)!;
}

export function updateSleep(
  ownerId: string,
  date: string,
  sleepHours: number
): FitnessDailyLog {
  db.prepare(
    `
    INSERT INTO fitness_daily (owner_id, date, sleep_hours, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      sleep_hours = excluded.sleep_hours,
      updated_at = excluded.updated_at
    `
  ).run(ownerId, date, sleepHours, now(), now());

  return getDailyLog(ownerId, date)!;
}

// ── 每日日志 ───────────────────────────────────────────────────

export function getDailyLog(ownerId: string, date: string): FitnessDailyLog | null {
  const row = db
    .prepare("SELECT * FROM fitness_daily WHERE owner_id = ? AND date = ?")
    .get(ownerId, date) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as number,
    ownerId: row.owner_id as string,
    date: row.date as string,
    calories: row.calories as number,
    proteinG: row.protein_g as number,
    carbsG: row.carbs_g as number,
    fatG: row.fat_g as number,
    waterMl: row.water_ml as number,
    sleepHours: row.sleep_hours as number,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function syncDailyLog(ownerId: string, date: string): void {
  // 从 meals 表汇总当日营养数据
  const totals = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(calories), 0) AS total_calories,
        COALESCE(SUM(protein_g), 0) AS total_protein,
        COALESCE(SUM(carbs_g), 0) AS total_carbs,
        COALESCE(SUM(fat_g), 0) AS total_fat
      FROM fitness_meals
      WHERE owner_id = ? AND date = ?
      `
    )
    .get(ownerId, date) as {
      total_calories: number;
      total_protein: number;
      total_carbs: number;
      total_fat: number;
    };

  const existing = db
    .prepare("SELECT id, water_ml, sleep_hours, notes FROM fitness_daily WHERE owner_id = ? AND date = ?")
    .get(ownerId, date) as { id: number; water_ml: number; sleep_hours: number; notes: string } | undefined;

  const waterMl = existing?.water_ml ?? 0;
  const sleepHours = existing?.sleep_hours ?? 0;
  const notes = existing?.notes ?? "";

  db.prepare(
    `
    INSERT INTO fitness_daily (owner_id, date, calories, protein_g, carbs_g, fat_g, water_ml, sleep_hours, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      calories = excluded.calories,
      protein_g = excluded.protein_g,
      carbs_g = excluded.carbs_g,
      fat_g = excluded.fat_g,
      water_ml = COALESCE(excluded.water_ml, fitness_daily.water_ml),
      sleep_hours = COALESCE(excluded.sleep_hours, fitness_daily.sleep_hours),
      notes = COALESCE(excluded.notes, fitness_daily.notes),
      updated_at = excluded.updated_at
    `
  ).run(
    ownerId, date,
    totals.total_calories, totals.total_protein, totals.total_carbs, totals.total_fat,
    waterMl, sleepHours, notes,
    now(), now()
  );
}

// ── 每日简报 ───────────────────────────────────────────────────

export function getDailySummary(
  ownerId: string,
  date: string
): DailySummary | null {
  const log = getDailyLog(ownerId, date);
  const meals = getMeals(ownerId, date);
  const workouts = getWorkouts(ownerId, date);
  const profile = getFitnessProfile(ownerId);

  if (!log && meals.length === 0 && workouts.length === 0) return null;

  const calories = log?.calories ?? 0;
  const protein = log?.proteinG ?? 0;
  const carbs = log?.carbsG ?? 0;
  const fat = log?.fatG ?? 0;

  const targetCalories = profile?.calorieTarget ?? 0;
  const proteinTarget = profile?.proteinTargetG ?? 0;
  const carbsTarget = profile?.carbsTargetG ?? 0;
  const fatTarget = profile?.fatTargetG ?? 0;

  return {
    date,
    calories,
    macros: { protein, carbs, fat },
    waterMl: log?.waterMl ?? 0,
    sleepHours: log?.sleepHours ?? 0,
    workouts,
    meals,
    remainingCalories: targetCalories > 0 ? targetCalories - calories : 0,
    macroProgress: {
      proteinPct: proteinTarget > 0 ? Math.round((protein / proteinTarget) * 100) : 0,
      carbsPct: carbsTarget > 0 ? Math.round((carbs / carbsTarget) * 100) : 0,
      fatPct: fatTarget > 0 ? Math.round((fat / fatTarget) * 100) : 0,
    },
  };
}

// ── 近7日趋势 ───────────────────────────────────────────────────

export function getWeeklyTrend(ownerId: string): Array<{
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number;
  sleepHours: number;
  workoutCount: number;
  totalWorkoutMinutes: number;
}> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const startDate = weekAgo.toISOString().slice(0, 10);
  const endDate = todayDate();

  const dailyRows = db
    .prepare(
      `
      SELECT * FROM fitness_daily
      WHERE owner_id = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
      `
    )
    .all(ownerId, startDate, endDate) as Array<Record<string, unknown>>;

  // 获取每日运动汇总
  const workoutSummary = db
    .prepare(
      `
      SELECT date, COUNT(*) AS count, COALESCE(SUM(duration_minutes), 0) AS total_minutes
      FROM fitness_workouts
      WHERE owner_id = ? AND date >= ? AND date <= ?
      GROUP BY date
      `
    )
    .all(ownerId, startDate, endDate) as Array<{ date: string; count: number; total_minutes: number }>;

  const workoutMap = new Map(workoutSummary.map((w) => [w.date, w]));

  return dailyRows.map((row) => {
    const date = row.date as string;
    const w = workoutMap.get(date);
    return {
      date,
      calories: row.calories as number,
      proteinG: row.protein_g as number,
      carbsG: row.carbs_g as number,
      fatG: row.fat_g as number,
      waterMl: row.water_ml as number,
      sleepHours: row.sleep_hours as number,
      workoutCount: w?.count ?? 0,
      totalWorkoutMinutes: w?.total_minutes ?? 0,
    };
  });
}

// ── 更新备注 ───────────────────────────────────────────────────

export function updateDailyNotes(
  ownerId: string,
  date: string,
  notes: string
): void {
  db.prepare(
    `
    INSERT INTO fitness_daily (owner_id, date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      notes = excluded.notes,
      updated_at = excluded.updated_at
    `
  ).run(ownerId, date, notes, now(), now());
}

// ── 历史查询 ───────────────────────────────────────────────────

export function getRecentWorkouts(
  ownerId: string,
  limit = 20
): FitnessWorkout[] {
  const rows = db
    .prepare(
      "SELECT * FROM fitness_workouts WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(ownerId, limit) as Array<Record<string, unknown>>;

  return rows.map(mapWorkoutRow);
}

export function getRecentMeals(ownerId: string, limit = 30): FitnessMeal[] {
  const rows = db
    .prepare(
      "SELECT * FROM fitness_meals WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(ownerId, limit) as Array<Record<string, unknown>>;

  return rows.map(mapMealRow);
}

// ── 行映射 ─────────────────────────────────────────────────────

function mapMealRow(row: Record<string, unknown>): FitnessMeal {
  return {
    id: row.id as number,
    ownerId: row.owner_id as string,
    date: row.date as string,
    mealType: row.meal_type as MealType,
    foodName: row.food_name as string,
    calories: row.calories as number,
    proteinG: row.protein_g as number,
    carbsG: row.carbs_g as number,
    fatG: row.fat_g as number,
    createdAt: row.created_at as string,
  };
}

function mapWorkoutRow(row: Record<string, unknown>): FitnessWorkout {
  return {
    id: row.id as number,
    ownerId: row.owner_id as string,
    date: row.date as string,
    type: row.type as WorkoutType,
    durationMinutes: row.duration_minutes as number,
    details: row.details as string,
    intensity: row.intensity as Intensity,
    createdAt: row.created_at as string,
  };
}
