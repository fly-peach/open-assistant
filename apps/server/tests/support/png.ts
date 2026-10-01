/**
 * 测试支撑：解我们自己生成的纯色 PNG。
 *
 * ## 为什么需要它
 *
 * 验证视觉探针时，替身「看得见图的模型」必须**真的从图片里读出颜色**。
 * 一开始图省事写成「拿 base64 字符串比对」，结果在跨进程时翻车：
 * 图片在服务端进程生成、替身在测试进程比对，两边的 zlib 输出不完全一致
 * （deflate 实现细节不同），base64 自然不同 —— 明明发的是同一张红图，替身却说没匹配上。
 *
 * 所以这里老老实实按 PNG 规范解一遍：找 IHDR 拿尺寸、拼 IDAT、inflate、
 * 读第一行（跳过过滤字节）。附带好处是它**顺带验证了我们的编码器写对了** ——
 * 一个真正的视觉模型看到的就是这个像素。
 */
import zlib from "node:zlib";

import { PROBE_COLORS, type ProbeColor } from "../../src/models/probe.js";

export interface DecodedPng {
  width: number;
  height: number;
  /** 每个像素的 RGB（按行优先） */
  pixels: Array<[number, number, number]>;
}

/** 解析 8 位真彩色（颜色类型 2）、无交错的 PNG */
export function decodePng(png: Buffer): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (png[i] !== signature[i]) throw new Error("不是 PNG（签名不匹配）");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || colorType !== 2) {
        throw new Error(`只支持 8 位真彩色 PNG（收到 bitDepth=${bitDepth} colorType=${colorType}）`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 3;
  const pixels: Array<[number, number, number]> = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    const filter = raw[rowStart];
    if (filter !== 0) throw new Error(`只支持 filter=None 的行（收到 ${filter}）`);
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      pixels.push([raw[at]!, raw[at + 1]!, raw[at + 2]!]);
    }
  }
  return { width, height, pixels };
}

/** 从请求体里抠出第一个 `data:image/png;base64,` 图片并解码 */
export function decodeFirstPngFromBody(body: string): DecodedPng {
  const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(body);
  if (!match) throw new Error("请求体里没有 PNG 图片");
  return decodePng(Buffer.from(match[1]!, "base64"));
}

/** 按欧氏距离取最接近的探测颜色（替身「认出」颜色的方式） */
export function nearestProbeColor(rgb: [number, number, number]): ProbeColor {
  let best = PROBE_COLORS[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of PROBE_COLORS) {
    const distance =
      (rgb[0] - color.rgb[0]) ** 2 + (rgb[1] - color.rgb[1]) ** 2 + (rgb[2] - color.rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best;
}
