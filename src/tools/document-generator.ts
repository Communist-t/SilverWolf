/**
 * 纯 JS 文档生成器（docx / pptx / pdf）
 *
 * 替代 scripts/skill_docs.py 的 Python 桥，消除对系统 Python 环境的依赖：
 *   - docx:   npm `docx` 库（Packer 纯内存打包 OOXML -> .docx）
 *   - pptx:   npm `pptxgenjs` 库
 *   - pdf:    npm `pdfkit` 库 + 系统中文字体嵌入（Windows 优先 simhei.ttf）
 * 三个生成器都不产生子进程，可在受限沙箱环境中稳定运行。
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// pptxgenjs 的类型声明（UMD `export as namespace`）在 NodeNext 下把 default 解析成模块命名空间，
// 这里用 createRequire 取运行时构造器并断言为本地接口；运行时导出即为类本身。
interface PptxGenInstance {
  defineLayout(layout: { name: string; width: number; height: number }): void;
  layout: string;
  addSlide(): {
    addText(text: unknown, opts?: Record<string, unknown>): void;
  };
  write(options: { outputType: "nodebuffer" }): Promise<Buffer>;
}
type PptxGenCtor = new () => PptxGenInstance;
const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs") as PptxGenCtor;

export interface GeneratedFile {
  /** 生成的完整文件路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
}

export interface DocxInput {
  output: string;
  title?: string;
  content: string;
}

export interface PptxSlide {
  title: string;
  points: string[];
}

export interface PptxInput {
  output: string;
  title?: string;
  slides: PptxSlide[];
}

export interface PdfInput {
  output: string;
  title?: string;
  content: string;
}

/** 将文本按 Markdown 简易风格转为 docx 段落（# 标题、- 列表、普通段落） */
function buildDocxParagraphs(content: string, title?: string): Paragraph[] {
  const children: Paragraph[] = [];
  if (title?.trim()) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: title.trim(), bold: true, size: 32 })],
      })
    );
  }
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^#{1,3}\s+/.test(trimmed)) {
      const hashes = /^(#{1,3})/.exec(trimmed)?.[1]?.length ?? 1;
      const text = trimmed.replace(/^#{1,3}\s+/, "");
      children.push(
        new Paragraph({
          heading: hashes === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          children: [new TextRun({ text })],
        })
      );
      continue;
    }
    if (/^[-*•·]\s+/.test(trimmed)) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: trimmed.replace(/^[-*•·]\s+/, "") })],
        })
      );
      continue;
    }
    children.push(new Paragraph({ children: [new TextRun({ text: trimmed })] }));
  }
  return children;
}

/** 生成 Word 文档（.docx），正文默认宋体 */
export async function generateDocx(input: DocxInput): Promise<GeneratedFile> {
  const content = String(input.content ?? "");
  if (!content.trim()) throw new Error("文档内容不能为空");
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "宋体", size: 24 } },
      },
    },
    sections: [{ children: buildDocxParagraphs(content, input.title) }],
  });
  const buffer = await Packer.toBuffer(doc);
  writeFileSync(input.output, buffer);
  return { path: input.output, size: buffer.byteLength };
}

/** 生成 PowerPoint 演示文稿（.pptx） */
export async function generatePptx(input: PptxInput): Promise<GeneratedFile> {
  const slides = Array.isArray(input.slides) ? input.slides : [];
  if (slides.length === 0) throw new Error("至少需要一页幻灯片");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  if (input.title?.trim()) {
    const cover = pptx.addSlide();
    cover.addText(input.title.trim(), {
      x: 0.8, y: 2.9, w: 11.7, h: 1.6,
      fontFace: "微软雅黑", fontSize: 40, bold: true, align: "center",
    });
  }

  for (const slide of slides) {
    const page = pptx.addSlide();
    if (slide.title?.trim()) {
      page.addText(slide.title.trim(), {
        x: 0.6, y: 0.35, w: 12.1, h: 0.9,
        fontFace: "微软雅黑", fontSize: 30, bold: true,
      });
    }
    const bullets = (Array.isArray(slide.points) ? slide.points : [])
      .filter((point) => String(point).trim())
      .map((point) => ({
        text: String(point).trim(),
        options: { bullet: true, fontSize: 18, breakLine: true },
      }));
    if (bullets.length > 0) {
      page.addText(bullets, {
        x: 0.8, y: 1.5, w: 11.7, h: 5.4,
        fontFace: "微软雅黑", valign: "top",
      });
    }
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
  writeFileSync(input.output, buffer);
  return { path: input.output, size: buffer.byteLength };
}

/** 常见中文字体候选（PDF 嵌入用，优先单字体 ttf） */
const CJK_FONT_CANDIDATES: string[] = [
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/simsun.ttc",
  "C:/Windows/Fonts/msyh.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

function findCjkFont(): string | undefined {
  for (const candidate of CJK_FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 生成 PDF 文档，嵌入中文字体保证中文可渲染 */
export async function generatePdf(input: PdfInput): Promise<GeneratedFile> {
  const content = String(input.content ?? "");
  if (!content.trim()) throw new Error("文档内容不能为空");
  const fontPath = findCjkFont();
  if (!fontPath) {
    throw new Error("未找到可用的中文字体，无法生成 PDF（请安装任一 CJK 字体）");
  }

  const doc = new PDFDocument({ size: "A4", margin: 60 });
  let fontName = "CJK";
  try {
    doc.registerFont(fontName, fontPath);
  } catch (error) {
    throw new Error(`中文字体加载失败（${fontPath}）：${error instanceof Error ? error.message : String(error)}`);
  }
  doc.font(fontName).fontSize(12).fillColor("#1a1a1a");

  if (input.title?.trim()) {
    doc.font(fontName).fontSize(22).fillColor("#111111").text(input.title.trim(), { align: "left" });
    doc.moveDown(0.6);
  }

  doc.font(fontName).fontSize(12).fillColor("#1a1a1a");
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^#{1,3}\s+/.test(trimmed)) {
      doc.fontSize(16).fillColor("#111111").text(trimmed.replace(/^#{1,6}\s*/, ""));
      doc.font(fontName).fontSize(12).fillColor("#1a1a1a");
    } else if (/^[-*•·]\s+/.test(trimmed)) {
      doc.text(`•  ${trimmed.replace(/^[-*•·]\s+/, "")}`, { indent: 12 });
    } else {
      doc.text(trimmed);
    }
    doc.moveDown(0.2);
  }

  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });
  doc.end();
  await done;
  const buffer = Buffer.concat(chunks);
  writeFileSync(input.output, buffer);
  return { path: input.output, size: buffer.byteLength };
}

/** 通用入口：按 action 生成文件（供 skill-executor 调用） */
export async function generateDocument(
  action: "create_docx" | "create_pptx" | "create_pdf",
  input: DocxInput | PptxInput | PdfInput
): Promise<GeneratedFile> {
  mkdirSync(dirname(input.output), { recursive: true });
  switch (action) {
    case "create_docx":
      return generateDocx(input as DocxInput);
    case "create_pptx":
      return generatePptx(input as PptxInput);
    case "create_pdf":
      return generatePdf(input as PdfInput);
    default:
      throw new Error(`未知文档生成动作: ${action}`);
  }
}