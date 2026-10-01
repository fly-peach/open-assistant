/**
 * 视觉能力探针：**真的发一张图过去，看它认不认得**。
 *
 * ## 为什么不用「查表」
 *
 * 模型清单里写死的 `vision` 只在认识这个模型时才对。用户填一个自建端点 /
 * 新发布的模型时没人知道它看不看得见图，而这件事**错了代价很大**：
 * 界面上标了「支持视觉」，用户发图，模型要么报错要么胡说（把图当乱码）。
 *
 * 所以照搬 QwenPaw 的做法 —— **构造一张已知答案的小图，问模型它是什么颜色**：
 *
 * 1. 生成 32×32 的纯色 PNG（内存里拼，不落盘、不引第三方图片库）；
 * 2. 用 OpenAI 多模态消息格式发过去（`image_url` + `data:` base64）；
 * 3. 换三种颜色各问一次，**答对 ≥2 次才算支持**。
 *
 * 为什么是「换颜色多次」而不是「一次定生死」：
 * 纯文本模型面对图片通常会**瞎猜**颜色，一次命中率不低（1/3）；
 * 三次里蒙对两次的概率降到约 1/9，而且我们要求三次颜色各不相同，
 * 「每次都答红色」这种退化解法会被抓出来。
 *
 * 结论只有三种，且**分清「看出来不行」与「没测出来」**：
 * - `true`  —— 至少答对两次；
 * - `false` —— 有效作答 ≥2 次但几乎都答错（典型：文本模型在猜、或明确说看不了图）；
 * - `null`  —— 全是网络/超时错误，**没结论**（界面显示「未知」，不写死 false）。
 */
import zlib from "node:zlib";

import { chatCompletion, type UpstreamResult } from "./client.js";

/* ------------------------------------------------------------------ PNG 生成 */

/** CRC32 查表（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 生成一张 `size × size` 的纯色 PNG（8 位真彩色，无交错）。
 * 手写而不是塞一个 base64 常量：颜色是参数，探针才能换色多次问。
 */
export function solidPng(rgb: readonly [number, number, number], size = 32): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型 2 = truecolor RGB
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 非交错

  // 每行开头一个过滤字节（0 = None），随后是 size 组 RGB
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const offset = y * stride;
    raw[offset] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[offset + 1 + x * 3] = rgb[0];
      raw[offset + 2 + x * 3] = rgb[1];
      raw[offset + 3 + x * 3] = rgb[2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 纯色 PNG 的 data URL */
export function solidPngDataUrl(rgb: readonly [number, number, number], size = 32): string {
  return `data:image/png;base64,${solidPng(rgb, size).toString("base64")}`;
}

/* ------------------------------------------------------------------ 判分 */

export interface ProbeColor {
  key: string;
  label: string;
  rgb: readonly [number, number, number];
  /** 判分用的别名（小写、去空格后做子串匹配） */
  aliases: string[];
}

/**
 * 三次探测用三种**色差极大**的颜色：红 / 绿 / 蓝。
 * 不用相近色（如深红/浅红）—— 模型答「红」时无法区分，判分会变糊。
 *
 * 导出是为了让验证代码（`tests/`、`scripts/probe-models.ts`）能拿同一份调色板
 * 去**解图核对**，而不是各抄一份常量（抄的那份迟早和这里不一致）。
 */
export const PROBE_COLORS: ProbeColor[] = [
  { key: "red", label: "红", rgb: [220, 30, 30], aliases: ["红色", "红", "red", "#dc1e1e"] },
  { key: "green", label: "绿", rgb: [30, 160, 70], aliases: ["绿色", "绿", "green", "#1ea046"] },
  { key: "blue", label: "蓝", rgb: [30, 80, 220], aliases: ["蓝色", "蓝", "blue", "#1e50dc"] },
];

/** 探针提问（要求短答，便于判分；也降低把「蓝」写成一段散文的概率） */
const PROBE_QUESTION = "这张图片是一个纯色方块。请只回答它的颜色名称，两三个字即可。";

function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "").replace(/[。.!！,，、]/g, "");
}

export function isCorrectAnswer(color: ProbeColor, answer: string): boolean {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
  return color.aliases.some((alias) => normalized.includes(alias));
}

/* ------------------------------------------------------------------ 探测 */

export interface ProbeAttempt {
  color: string;
  /** 模型的原话（截断到 200 字，够看它是不是在猜） */
  answer?: string;
  error?: string;
  correct: boolean;
}

export interface VisionProbeResult {
  /** null = 没测出结论（全是网络错误），界面显示「未知」 */
  vision: boolean | null;
  correct: number;
  /** 有效作答次数（不含网络失败） */
  answered: number;
  attempts: ProbeAttempt[];
  /** 给人看的一句话结论 */
  reason: string;
}

/** 默认探测次数（三次三种颜色） */
export const PROBE_ATTEMPTS = 3;
/** 连续失败达到这个次数后，不再自动重试（用户仍可手动再探） */
export const PROBE_MAX_FAILURES = 3;

export interface ProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  attempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 探测一次视觉能力。**不抛异常** —— 探测失败本身是要展示给用户的信息。
 */
export async function probeVision(input: ProbeInput): Promise<VisionProbeResult> {
  const attempts = Math.max(1, Math.min(input.attempts ?? PROBE_ATTEMPTS, PROBE_COLORS.length));
  const results: ProbeAttempt[] = [];

  for (let i = 0; i < attempts; i += 1) {
    const color = PROBE_COLORS[i]!;
    const completion: UpstreamResult = await chatCompletion({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROBE_QUESTION },
            { type: "image_url", image_url: { url: solidPngDataUrl(color.rgb) } },
          ],
        },
      ],
      maxTokens: 24,
      temperature: 0,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!completion.ok) {
      results.push({ color: color.label, correct: false, ...(completion.error ? { error: completion.error } : {}) });
      continue;
    }
    const answer = completion.text.trim().slice(0, 200);
    results.push({ color: color.label, answer, correct: isCorrectAnswer(color, completion.text) });
  }

  const correct = results.filter((r) => r.correct).length;
  const answered = results.filter((r) => r.answer !== undefined).length;

  if (correct >= Math.ceil(attempts / 2)) {
    return {
      vision: true,
      correct,
      answered,
      attempts: results,
      reason: `三次探测答对 ${correct} 次，判定支持图像输入`,
    };
  }
  if (answered >= 2) {
    return {
      vision: false,
      correct,
      answered,
      attempts: results,
      reason: `有效作答 ${answered} 次、答对 ${correct} 次，判定不支持图像输入（更像是在猜或明确看不到图）`,
    };
  }
  return {
    vision: null,
    correct,
    answered,
    attempts: results,
    reason: `有效作答仅 ${answered} 次（其余是网络/超时错误），无法判断 —— 请检查 baseUrl 与 API Key 后重试`,
  };
}
