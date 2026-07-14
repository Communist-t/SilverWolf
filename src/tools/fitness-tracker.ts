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

import { pool } from "../db/pool.js";

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

const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// ── BMR 计算 ───────────────────────────────────────────────────

export function calculateBmr(
  weightKg: number,
  heightCm: number,
  age: number,
  gender: FitnessGender
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === "male" ? base + 5 : base - 161);
}

export function calculateMaintenanceCalories(
  bmr: number,
  activityLevel: ActivityLevel
): number {
  return Math.round(bmr * ACTIVITY_MULTIPLIER[activityLevel]);
}

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

export async function getFitnessProfile(ownerId: string): Promise<FitnessProfile | null> {
  const result = await pool.query("SELECT * FROM fitness_profile WHERE owner_id = $1", [ownerId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    ownerId: row.owner_id,
    bmr: Number(row.bmr),
    calorieTarget: Number(row.calorie_target),
    proteinTargetG: Number(row.protein_target_g),
    carbsTargetG: Number(row.carbs_target_g),
    fatTargetG: Number(row.fat_target_g),
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : undefined,
    heightCm: row.height_cm != null ? Number(row.height_cm) : undefined,
    age: row.age != null ? Number(row.age) : undefined,
    gender: row.gender ?? undefined,
    activityLevel: row.activity_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertFitnessProfile(
  ownerId: string,
  data: {
    weightKg?: number;
    heightCm?: number;
    age?: number;
    gender?: FitnessGender;
    activityLevel?: ActivityLevel;
    calorieTarget?: number;
  }
): Promise<FitnessProfile> {
  const existing = await getFitnessProfile(ownerId);
  const timestamp = now();

  const weightKg = data.weightKg ?? existing?.weightKg;
  const heightCm = data.heightCm ?? existing?.heightCm;
  const age = data.age ?? existing?.age;
  const gender = data.gender ?? existing?.gender;
  const activityLevel = data.activityLevel ?? existing?.activityLevel ?? "sedentary";

  let bmr = existing?.bmr ?? 0;
  let calorieTarget = data.calorieTarget ?? existing?.calorieTarget ?? 0;

  if (weightKg && heightCm && age && gender) {
    bmr = calculateBmr(weightKg, heightCm, age, gender);
    if (!data.calorieTarget || calorieTarget === 0) {
      calorieTarget = bmr;
    }
  }

  const macros = calculateMacroSplit(calorieTarget);

  await pool.query(
    `
    INSERT INTO fitness_profile (
      owner_id, bmr, calorie_target,
      protein_target_g, carbs_target_g, fat_target_g,
      weight_kg, height_cm, age, gender, activity_level,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT(owner_id) DO UPDATE SET
      bmr = EXCLUDED.bmr,
      calorie_target = EXCLUDED.calorie_target,
      protein_target_g = EXCLUDED.protein_target_g,
      carbs_target_g = EXCLUDED.carbs_target_g,
      fat_target_g = EXCLUDED.fat_target_g,
      weight_kg = EXCLUDED.weight_kg,
      height_cm = EXCLUDED.height_cm,
      age = EXCLUDED.age,
      gender = EXCLUDED.gender,
      activity_level = EXCLUDED.activity_level,
      updated_at = EXCLUDED.updated_at
    `,
    [
      ownerId, bmr, calorieTarget,
      macros.proteinG, macros.carbsG, macros.fatG,
      weightKg ?? null, heightCm ?? null, age ?? null, gender ?? null, activityLevel,
      timestamp, timestamp
    ]
  );

  return (await getFitnessProfile(ownerId))!;
}

// ── 日常饮食记录 ───────────────────────────────────────────────

export async function addMeal(
  ownerId: string,
  date: string,
  mealType: MealType,
  foodName: string,
  calories: number,
  proteinG = 0,
  carbsG = 0,
  fatG = 0
): Promise<FitnessMeal> {
  const timestamp = now();
  const result = await pool.query<{ id: number }>(
    `
    INSERT INTO fitness_meals (owner_id, date, meal_type, food_name, calories, protein_g, carbs_g, fat_g, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
    `,
    [ownerId, date, mealType, foodName, calories, proteinG, carbsG, fatG, timestamp]
  );

  await syncDailyLog(ownerId, date);

  return {
    id: result.rows[0].id,
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

export async function getMeals(ownerId: string, date: string): Promise<FitnessMeal[]> {
  const result = await pool.query(
    "SELECT * FROM fitness_meals WHERE owner_id = $1 AND date = $2 ORDER BY created_at ASC",
    [ownerId, date]
  );
  return result.rows.map(mapMealRow);
}

export async function deleteMeal(mealId: number, ownerId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT owner_id, date FROM fitness_meals WHERE id = $1",
    [mealId]
  );
  if (result.rows.length === 0 || result.rows[0].owner_id !== ownerId) return false;

  await pool.query("DELETE FROM fitness_meals WHERE id = $1", [mealId]);
  await syncDailyLog(ownerId, result.rows[0].date);
  return true;
}

// ── 运动记录 ───────────────────────────────────────────────────

export async function addWorkout(
  ownerId: string,
  date: string,
  type: WorkoutType,
  durationMinutes: number,
  details = "",
  intensity: Intensity = "moderate"
): Promise<FitnessWorkout> {
  const timestamp = now();
  const result = await pool.query<{ id: number }>(
    `
    INSERT INTO fitness_workouts (owner_id, date, type, duration_minutes, details, intensity, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
    `,
    [ownerId, date, type, durationMinutes, details, intensity, timestamp]
  );

  return {
    id: result.rows[0].id,
    ownerId,
    date,
    type,
    durationMinutes,
    details,
    intensity,
    createdAt: timestamp,
  };
}

export async function getWorkouts(ownerId: string, date: string): Promise<FitnessWorkout[]> {
  const result = await pool.query(
    "SELECT * FROM fitness_workouts WHERE owner_id = $1 AND date = $2 ORDER BY created_at ASC",
    [ownerId, date]
  );
  return result.rows.map(mapWorkoutRow);
}

export async function deleteWorkout(workoutId: number, ownerId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT owner_id FROM fitness_workouts WHERE id = $1",
    [workoutId]
  );
  if (result.rows.length === 0 || result.rows[0].owner_id !== ownerId) return false;

  await pool.query("DELETE FROM fitness_workouts WHERE id = $1", [workoutId]);
  return true;
}

// ── 水分与睡眠 ─────────────────────────────────────────────────

export async function updateHydration(
  ownerId: string,
  date: string,
  waterMl: number
): Promise<FitnessDailyLog> {
  await pool.query(
    `
    INSERT INTO fitness_daily (owner_id, date, water_ml, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      water_ml = EXCLUDED.water_ml,
      updated_at = EXCLUDED.updated_at
    `,
    [ownerId, date, waterMl, now(), now()]
  );

  return (await getDailyLog(ownerId, date))!;
}

export async function updateSleep(
  ownerId: string,
  date: string,
  sleepHours: number
): Promise<FitnessDailyLog> {
  await pool.query(
    `
    INSERT INTO fitness_daily (owner_id, date, sleep_hours, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      sleep_hours = EXCLUDED.sleep_hours,
      updated_at = EXCLUDED.updated_at
    `,
    [ownerId, date, sleepHours, now(), now()]
  );

  return (await getDailyLog(ownerId, date))!;
}

// ── 每日日志 ───────────────────────────────────────────────────

export async function getDailyLog(ownerId: string, date: string): Promise<FitnessDailyLog | null> {
  const result = await pool.query(
    "SELECT * FROM fitness_daily WHERE owner_id = $1 AND date = $2",
    [ownerId, date]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    ownerId: row.owner_id,
    date: row.date,
    calories: Number(row.calories),
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
    waterMl: Number(row.water_ml),
    sleepHours: Number(row.sleep_hours),
    notes: row.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function syncDailyLog(ownerId: string, date: string): Promise<void> {
  const totalsResult = await pool.query<{
    total_calories: number;
    total_protein: number;
    total_carbs: number;
    total_fat: number;
  }>(
    `
      SELECT
        COALESCE(SUM(calories), 0) AS total_calories,
        COALESCE(SUM(protein_g), 0) AS total_protein,
        COALESCE(SUM(carbs_g), 0) AS total_carbs,
        COALESCE(SUM(fat_g), 0) AS total_fat
      FROM fitness_meals
      WHERE owner_id = $1 AND date = $2
    `,
    [ownerId, date]
  );
  const totals = totalsResult.rows[0];

  const existingResult = await pool.query<{ id: number; water_ml: number; sleep_hours: number; notes: string }>(
    "SELECT id, water_ml, sleep_hours, notes FROM fitness_daily WHERE owner_id = $1 AND date = $2",
    [ownerId, date]
  );
  const existing = existingResult.rows[0];

  const waterMl = existing?.water_ml ?? 0;
  const sleepHours = existing?.sleep_hours ?? 0;
  const notes = existing?.notes ?? "";

  await pool.query(
    `
    INSERT INTO fitness_daily (owner_id, date, calories, protein_g, carbs_g, fat_g, water_ml, sleep_hours, notes, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      calories = EXCLUDED.calories,
      protein_g = EXCLUDED.protein_g,
      carbs_g = EXCLUDED.carbs_g,
      fat_g = EXCLUDED.fat_g,
      water_ml = COALESCE(EXCLUDED.water_ml, fitness_daily.water_ml),
      sleep_hours = COALESCE(EXCLUDED.sleep_hours, fitness_daily.sleep_hours),
      notes = COALESCE(EXCLUDED.notes, fitness_daily.notes),
      updated_at = EXCLUDED.updated_at
    `,
    [
      ownerId, date,
      totals.total_calories, totals.total_protein, totals.total_carbs, totals.total_fat,
      waterMl, sleepHours, notes,
      now(), now()
    ]
  );
}

// ── 每日简报 ───────────────────────────────────────────────────

export async function getDailySummary(
  ownerId: string,
  date: string
): Promise<DailySummary | null> {
  const log = await getDailyLog(ownerId, date);
  const meals = await getMeals(ownerId, date);
  const workouts = await getWorkouts(ownerId, date);
  const profile = await getFitnessProfile(ownerId);

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

export async function getWeeklyTrend(ownerId: string): Promise<Array<{
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number;
  sleepHours: number;
  workoutCount: number;
  totalWorkoutMinutes: number;
}>> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const startDate = weekAgo.toISOString().slice(0, 10);
  const endDate = todayDate();

  const dailyResult = await pool.query(
    `
    SELECT * FROM fitness_daily
    WHERE owner_id = $1 AND date >= $2 AND date <= $3
    ORDER BY date ASC
    `,
    [ownerId, startDate, endDate]
  );

  const workoutSummaryResult = await pool.query<{ date: string; count: number; total_minutes: number }>(
    `
    SELECT date, COUNT(*) AS count, COALESCE(SUM(duration_minutes), 0) AS total_minutes
    FROM fitness_workouts
    WHERE owner_id = $1 AND date >= $2 AND date <= $3
    GROUP BY date
    `,
    [ownerId, startDate, endDate]
  );

  const workoutMap = new Map(workoutSummaryResult.rows.map((w) => [w.date, w]));

  return dailyResult.rows.map((row) => {
    const w = workoutMap.get(row.date);
    return {
      date: row.date,
      calories: Number(row.calories),
      proteinG: Number(row.protein_g),
      carbsG: Number(row.carbs_g),
      fatG: Number(row.fat_g),
      waterMl: Number(row.water_ml),
      sleepHours: Number(row.sleep_hours),
      workoutCount: Number(w?.count ?? 0),
      totalWorkoutMinutes: Number(w?.total_minutes ?? 0),
    };
  });
}

// ── 更新备注 ───────────────────────────────────────────────────

export async function updateDailyNotes(
  ownerId: string,
  date: string,
  notes: string
): Promise<void> {
  await pool.query(
    `
    INSERT INTO fitness_daily (owner_id, date, notes, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(owner_id, date) DO UPDATE SET
      notes = EXCLUDED.notes,
      updated_at = EXCLUDED.updated_at
    `,
    [ownerId, date, notes, now(), now()]
  );
}

// ── 历史查询 ───────────────────────────────────────────────────

export async function getRecentWorkouts(
  ownerId: string,
  limit = 20
): Promise<FitnessWorkout[]> {
  const result = await pool.query(
    "SELECT * FROM fitness_workouts WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2",
    [ownerId, limit]
  );
  return result.rows.map(mapWorkoutRow);
}

export async function getRecentMeals(ownerId: string, limit = 30): Promise<FitnessMeal[]> {
  const result = await pool.query(
    "SELECT * FROM fitness_meals WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2",
    [ownerId, limit]
  );
  return result.rows.map(mapMealRow);
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
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
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
