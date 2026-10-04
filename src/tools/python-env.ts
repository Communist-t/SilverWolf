/**
 * Python 环境自动探测
 *
 * 银狼调用文档技能（docx/pptx/pdf）前，先自动探测当前系统中可用的 Python：
 * 1. 优先使用 PYTHON_BIN 环境变量显式指定的解释器；
 * 2. 否则依次尝试 python / python3 / py（Windows launcher）；
 * 3. 验证该解释器能否导入文档所需库（python-docx / python-pptx / pypdf / reportlab）；
 * 4. 缺库时尝试用 pip 自动补齐；
 * 5. 结果缓存，避免每次调用都探测。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

/** 文档技能所需的 Python 模块 -> pip 包名 */
const REQUIRED_MODULES: Record<string, string> = {
  docx: "python-docx",
  pptx: "python-pptx",
  pypdf: "pypdf",
  reportlab: "reportlab",
};

export interface PythonEnv {
  /** 选中的 Python 解释器命令（可能是路径，也可能是 python/py） */
  bin: string;
  /** 版本信息（如 Python 3.13.13） */
  version: string;
  /** 是否可用且依赖齐全 */
  ok: boolean;
  /** 缺失的模块名 */
  missingLibs: string[];
  error?: string;
}

let cached: PythonEnv | null = null;

function isPyLauncher(bin: string): boolean {
  return bin.trim().toLowerCase() === "py" || /py\.exe$/i.test(bin);
}

/** 生成候选解释器列表（PYTHON_BIN 优先） */
function candidates(): string[] {
  const list: string[] = [];
  if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
    list.push(process.env.PYTHON_BIN.trim());
  }
  list.push("python", "python3");
  if (process.platform === "win32") {
    list.push("py");
  }
  return list;
}

/** 检查指定解释器缺少哪些模块 */
async function checkMissingLibs(bin: string): Promise<string[]> {
  const probe =
    "import importlib.util,sys; print(' '.join(m for m in ['docx','pptx','pypdf','reportlab'] if importlib.util.find_spec(m) is None))";
  try {
    const args = isPyLauncher(bin) ? ["-3", "-c", probe] : ["-c", probe];
    const { stdout } = await execFileAsync(bin, args, { timeout: 10_000 });
    return stdout.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [...Object.keys(REQUIRED_MODULES)];
  }
}

/** 尝试用 pip 补齐缺失模块 */
async function installMissingLibs(bin: string, missing: string[]): Promise<string[]> {
  const pipNames = missing.map((m) => REQUIRED_MODULES[m]).filter(Boolean);
  if (pipNames.length === 0) return missing;
  try {
    const args = isPyLauncher(bin)
      ? ["-3", "-m", "pip", "install", "--quiet", ...pipNames]
      : ["-m", "pip", "install", "--quiet", ...pipNames];
    await execFileAsync(bin, args, { timeout: 240_000 });
    return checkMissingLibs(bin);
  } catch (error) {
    logger.warn("python-env", "auto pip install failed", {
      bin,
      libs: pipNames,
      error: error instanceof Error ? error.message : String(error),
    });
    return missing;
  }
}

async function detectOnce(): Promise<PythonEnv> {
  const seen = new Set<string>();
  for (const bin of candidates()) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    let version = "";
    try {
      const args = isPyLauncher(bin) ? ["-3", "--version"] : ["--version"];
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 8_000 });
      version = (stdout || stderr).trim() || bin;
    } catch {
      continue; // 这个解释器不可用，尝试下一个
    }

    let missing = await checkMissingLibs(bin);
    if (missing.length > 0) {
      logger.info("python-env", "missing libs, attempting auto install", {
        bin,
        version,
        missing,
      });
      missing = await installMissingLibs(bin, missing);
    }

    const env: PythonEnv = {
      bin,
      version,
      ok: missing.length === 0,
      missingLibs: missing,
    };
    if (env.ok) {
      logger.info("python-env", "resolved python environment", {
        bin,
        version,
      });
      return env;
    }
    logger.warn("python-env", "python found but libs unavailable", {
      bin,
      version,
      missing: env.missingLibs,
    });
  }

  return {
    bin: "",
    version: "",
    ok: false,
    missingLibs: [...Object.keys(REQUIRED_MODULES)],
    error: "未找到可用的 Python 解释器（已尝试 PYTHON_BIN / python / python3 / py）",
  };
}

/** 获取可用的 Python 环境（带缓存）；调用方应检查 .ok */
export async function resolvePythonEnv(): Promise<PythonEnv> {
  if (cached) return cached;
  cached = await detectOnce();
  return cached;
}

/** 重置缓存（测试或环境变更时使用） */
export function resetPythonEnvCache(): void {
  cached = null;
}
