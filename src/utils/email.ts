import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  const smtp = config.smtp;
  if (!smtp.host || !smtp.user || !smtp.pass) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
  }
  return transporter;
}

export async function sendVerificationCode(
  email: string,
  code: string
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn("email", "SMTP not configured, skipping verification email", {
      email,
      code,
    });
    return;
  }

  await t.sendMail({
    from: config.smtp.from || config.smtp.user,
    to: email,
    subject: "银狼 Agent 注册验证码",
    text: `您的注册验证码是：${code}\n验证码 5 分钟内有效。`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e8e9f1;border-radius:8px;">
      <h2 style="color:#191a24;margin:0 0 16px;">银狼 Agent 注册验证</h2>
      <p style="color:#7b7f91;font-size:14px;line-height:1.6;">您的注册验证码：</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;color:#6046ec;padding:16px 0;background:#efedff;border-radius:6px;margin:12px 0;">${code}</div>
      <p style="color:#7b7f91;font-size:12px;">验证码 5 分钟内有效，请勿泄露给他人。</p>
    </div>`,
  });

  logger.info("email", "verification code sent", { email });
}
