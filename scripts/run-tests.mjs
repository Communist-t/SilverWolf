/**
 * 测试运行入口：在独立测试库（silver_wolf_agent_test）上运行回归测试，
 * 防止 npm test 的 TRUNCATE / INSERT 污染真实数据库。
 *
 * 用法：npm test（package.json 的 test 脚本指向本文件）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const TEST_DB_NAME = "silver_wolf_agent_test";

function loadBaseUrl() {
  const envPath = ".env";
  if (!existsSync(envPath)) {
    console.error("[test-db] 缺少 .env，无法读取 DATABASE_URL");
    process.exit(1);
  }
  const content = readFileSync(envPath, "utf-8");
  const match = content.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    console.error("[test-db] .env 中未找到 DATABASE_URL");
    process.exit(1);
  }
  return match[1].trim();
}

function deriveTestUrl(baseUrl) {
  // 仅替换库名，保留用户/密码/主机
  return baseUrl.replace(/\/[^/]*$/, `/${TEST_DB_NAME}`);
}

async function ensureTestDatabase(baseUrl) {
  const testUrl = deriveTestUrl(baseUrl);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [TEST_DB_NAME]
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      console.log(`[test-db] 已创建测试库 ${TEST_DB_NAME}`);
    } else {
      console.log(`[test-db] 测试库 ${TEST_DB_NAME} 已存在`);
    }
  } finally {
    await admin.end();
  }
  return testUrl;
}

// ── 入口 ─────────────────────────────────────────────────────
const baseUrl = loadBaseUrl();
const testUrl = await ensureTestDatabase(baseUrl);

const testFiles = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/${f}`);
console.log(`[test-db] 运行测试于独立库 ${TEST_DB_NAME}（${testFiles.length} 个文件）`);

const result = spawnSync(
  "npx",
  ["tsx", "--test", "--test-concurrency=1", ...testFiles],
  {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: testUrl },
  }
);
process.exit(result.status ?? 1);
