/**
 * 健身追踪 API 路由
 *
 * 提供健身档案管理、饮食记录、运动记录、睡眠与水分追踪的 REST 接口。
 */

import { Hono } from "hono";
import {
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
  getRecentWorkouts,
  getRecentMeals,
  updateDailyNotes,
  generateFatLossPlan,
  calculateMacroSplit,
} from "../tools/fitness-tracker.js";
import type { FitnessGender, ActivityLevel } from "../tools/fitness-tracker.js";
import { logger } from "../logger.js";

export const fitnessRoute = new Hono();

// ── 类型推断辅助 ───────────────────────────────────────────────

function ownerFrom(c: any): string {
  return c.get("userId") ?? "local-default";
}

// ── 健身档案 ───────────────────────────────────────────────────

fitnessRoute.get("/profile", async (c) => {
  const profile = await getFitnessProfile(ownerFrom(c));
  if (!profile) return c.json({ error: "未设置健身档案" }, 404);
  return c.json(profile);
});

fitnessRoute.post("/profile", async (c) => {
  const body = await c.req.json<{
    weightKg?: number;
    heightCm?: number;
    age?: number;
    gender?: FitnessGender;
    activityLevel?: ActivityLevel;
    calorieTarget?: number;
  }>();

  const profile = await upsertFitnessProfile(ownerFrom(c), body);
  return c.json(profile);
});

// ── 饮食记录 ───────────────────────────────────────────────────

fitnessRoute.post("/meals", async (c) => {
  const body = await c.req.json<{
    date: string;
    mealType: "breakfast" | "lunch" | "dinner" | "snack";
    foodName: string;
    calories: number;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
  }>();

  if (!body.date || !body.mealType || !body.foodName || body.calories === undefined) {
    return c.json({ error: "缺少必填字段：date, mealType, foodName, calories" }, 400);
  }

  const meal = await addMeal(
    ownerFrom(c),
    body.date,
    body.mealType,
    body.foodName,
    body.calories,
    body.proteinG ?? 0,
    body.carbsG ?? 0,
    body.fatG ?? 0
  );
  return c.json(meal, 201);
});

fitnessRoute.get("/meals", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const meals = await getMeals(ownerFrom(c), date);
  return c.json(meals);
});

fitnessRoute.delete("/meals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "无效的 meal ID" }, 400);
  const deleted = await deleteMeal(id, ownerFrom(c));
  if (!deleted) return c.json({ error: "记录不存在或无权操作" }, 404);
  return c.json({ success: true });
});

// ── 运动记录 ───────────────────────────────────────────────────

fitnessRoute.post("/workouts", async (c) => {
  const body = await c.req.json<{
    date: string;
    type: "cardio" | "strength" | "mixed";
    durationMinutes: number;
    details?: string;
    intensity?: "low" | "moderate" | "high";
  }>();

  if (!body.date || !body.type || !body.durationMinutes) {
    return c.json({ error: "缺少必填字段：date, type, durationMinutes" }, 400);
  }

  const workout = await addWorkout(
    ownerFrom(c),
    body.date,
    body.type,
    body.durationMinutes,
    body.details ?? "",
    body.intensity ?? "moderate"
  );
  return c.json(workout, 201);
});

fitnessRoute.get("/workouts", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const workouts = await getWorkouts(ownerFrom(c), date);
  return c.json(workouts);
});

fitnessRoute.delete("/workouts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "无效的 workout ID" }, 400);
  const deleted = await deleteWorkout(id, ownerFrom(c));
  if (!deleted) return c.json({ error: "记录不存在或无权操作" }, 404);
  return c.json({ success: true });
});

// ── 水分与睡眠 ─────────────────────────────────────────────────

fitnessRoute.post("/hydration", async (c) => {
  const body = await c.req.json<{ date: string; waterMl: number }>();
  if (!body.date || !body.waterMl) {
    return c.json({ error: "缺少必填字段：date, waterMl" }, 400);
  }
  const log = await updateHydration(ownerFrom(c), body.date, body.waterMl);
  return c.json(log);
});

fitnessRoute.post("/sleep", async (c) => {
  const body = await c.req.json<{ date: string; sleepHours: number }>();
  if (!body.date || !body.sleepHours) {
    return c.json({ error: "缺少必填字段：date, sleepHours" }, 400);
  }
  const log = await updateSleep(ownerFrom(c), body.date, body.sleepHours);
  return c.json(log);
});

// ── 每日日志 ───────────────────────────────────────────────────

fitnessRoute.get("/daily", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const log = await getDailyLog(ownerFrom(c), date);
  if (!log) return c.json({ error: "当日无记录" }, 404);
  return c.json(log);
});

fitnessRoute.get("/summary", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const summary = await getDailySummary(ownerFrom(c), date);
  if (!summary) return c.json({ error: "当日无记录" }, 404);
  return c.json(summary);
});

fitnessRoute.get("/weekly", async (c) => {
  const trend = await getWeeklyTrend(ownerFrom(c));
  return c.json(trend);
});

fitnessRoute.post("/notes", async (c) => {
  const body = await c.req.json<{ date: string; notes: string }>();
  if (!body.date || body.notes === undefined) {
    return c.json({ error: "缺少必填字段：date, notes" }, 400);
  }
  await updateDailyNotes(ownerFrom(c), body.date, body.notes);
  return c.json({ success: true });
});

// ── 计算工具 ───────────────────────────────────────────────────

fitnessRoute.post("/calculate/plan", async (c) => {
  const body = await c.req.json<{
    weightKg: number;
    heightCm: number;
    age: number;
    gender: FitnessGender;
    activityLevel?: ActivityLevel;
    deficitCal?: number;
  }>();

  if (!body.weightKg || !body.heightCm || !body.age || !body.gender) {
    return c.json({ error: "缺少必填字段：weightKg, heightCm, age, gender" }, 400);
  }

  const plan = generateFatLossPlan(
    body.weightKg,
    body.heightCm,
    body.age,
    body.gender,
    body.activityLevel ?? "sedentary",
    body.deficitCal ?? 300
  );
  return c.json(plan);
});

fitnessRoute.post("/calculate/macros", async (c) => {
  const body = await c.req.json<{ totalCalories: number }>();
  if (!body.totalCalories) {
    return c.json({ error: "缺少必填字段：totalCalories" }, 400);
  }
  const macros = calculateMacroSplit(body.totalCalories);
  return c.json(macros);
});
