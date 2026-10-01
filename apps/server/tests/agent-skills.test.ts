/**
 * 技能体系：共享池继承 + 私有技能增删 + 启用/关闭 + 覆盖优先级 + 渐进披露注入。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SystemMessage } from "@langchain/core/messages";

import { AGENTS_ROOT_ENV } from "../src/agents/root.js";
import {
  clearAgentRuntimeCache,
  createAgent,
  createAgentSkill,
  deleteAgentSkill,
  importAgentSkill,
  readAgent,
  setAgentSkillEnabled,
  uploadAgentSkill,
} from "../src/agents/registry.js";
import { isValidSkillName, listEffectiveSkills } from "../src/agents/skills.js";
import { BASE_SKILLS, ensureBaseSkills } from "../src/agents/base-skills.js";
import { withAgentSkills } from "../src/persona.js";

let root: string;
const originalRoot = process.env[AGENTS_ROOT_ENV];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-skills-")));
  process.env[AGENTS_ROOT_ENV] = root;
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env[AGENTS_ROOT_ENV];
  else process.env[AGENTS_ROOT_ENV] = originalRoot;
  clearAgentRuntimeCache();
  await fs.rm(root, { recursive: true, force: true });
});

function agentDir(id: string): string {
  return path.join(root, id);
}

describe("技能名校验", () => {
  test("接受安全目录名，拒绝分隔符 / 前导点 / 超长", () => {
    expect(isValidSkillName("note-taking")).toBe(true);
    expect(isValidSkillName("a1.b_c")).toBe(true);
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName(".hidden")).toBe(false);
    expect(isValidSkillName("a/b")).toBe(false);
    expect(isValidSkillName("a\\b")).toBe(false);
    expect(isValidSkillName("..")).toBe(false);
    expect(isValidSkillName("x".repeat(65))).toBe(false);
  });
});

describe("共享池继承", () => {
  test("新建 agent 继承共享池的基础技能（source=shared）", async () => {
    await createAgent({ id: "helper", name: "助手" });
    const def = await readAgent("helper");
    const names = def.skills.map((s) => s.name).sort();
    expect(names).toEqual(BASE_SKILLS.map((s) => s.name).sort());
    expect(def.skills.every((s) => s.source === "shared")).toBe(true);
    expect(def.skills.every((s) => s.disabled === false)).toBe(true);
    // 共享池落在 _shared/skills 下，而不是 agent 目录里
    expect(await fs.stat(path.join(root, "_shared", "skills")).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.stat(path.join(agentDir("helper"), "skills")).then((s) => s.isDirectory())).toBe(true);
  });

  test("播种幂等：用户改过的共享技能不会被再次初始化冲掉", async () => {
    // 用第 3 个基础技能做篡改，避免影响后面用例依赖的基础技能
    const target = BASE_SKILLS[2]!;
    const file = path.join(root, "_shared", "skills", target.name, "SKILL.md");
    await fs.writeFile(file, "---\nname: custom-check\ndescription: 用户改过\n---\n\n正文\n", "utf8");
    const created = await ensureBaseSkills(root);
    expect(created).not.toContain(target.name);
    expect(await fs.readFile(file, "utf8")).toContain("用户改过");
  });
});

describe("私有技能的增删 / 覆盖 / 启停", () => {
  test("新增私有技能 → 出现在生效列表且 source=agent", async () => {
    await createAgentSkill("helper", {
      name: "my-skill",
      description: "我的技能",
      content: "# 正文\n按我说的做",
    });
    const skills = await listEffectiveSkills(agentDir("helper"));
    const mine = skills.find((s) => s.name === "my-skill");
    expect(mine?.source).toBe("agent");
    expect(mine?.description).toBe("我的技能");
  });

  test("私有技能与共享技能同名 → 私有优先并标注覆盖", async () => {
    const baseName = BASE_SKILLS[0]!.name;
    await createAgentSkill("helper", { name: baseName, description: "私有覆盖版", content: "# 覆盖" });
    const skills = await listEffectiveSkills(agentDir("helper"));
    const hit = skills.find((s) => s.name === baseName);
    expect(hit?.source).toBe("agent");
    expect(hit?.description).toBe("私有覆盖版");
    expect(hit?.overridesShared).toBe(true);
    // 同名只出现一次
    expect(skills.filter((s) => s.name === baseName).length).toBe(1);
  });

  test("关闭技能只影响该 agent（写 disabledSkills）", async () => {
    await setAgentSkillEnabled("helper", "my-skill", false);
    const def = await readAgent("helper");
    expect(def.skills.find((s) => s.name === "my-skill")?.disabled).toBe(true);
    // 再打开
    await setAgentSkillEnabled("helper", "my-skill", true);
    const reopened = await readAgent("helper");
    expect(reopened.skills.find((s) => s.name === "my-skill")?.disabled).toBe(false);
  });

  test("删除私有技能 → 消失；共享技能删不掉（只可关）", async () => {
    await deleteAgentSkill("helper", "my-skill");
    const skills = await listEffectiveSkills(agentDir("helper"));
    expect(skills.find((s) => s.name === "my-skill")).toBeUndefined();

    const baseName = BASE_SKILLS[0]!.name;
    // 上一条用例建了同名私有技能 → 先删掉它（合法的私有删除）
    await deleteAgentSkill("helper", baseName);
    // 现在同名只剩共享技能，再删会失败（共享技能不能删，只能关）
    await expect(deleteAgentSkill("helper", baseName)).rejects.toThrow(/找不到 agent 私有技能/);
    const still = await listEffectiveSkills(agentDir("helper"));
    expect(still.some((s) => s.name === baseName)).toBe(true);
  });
});

describe("从文件夹导入技能", () => {
  test("整份复制 SKILL.md 到 agent 私有目录；名单无 SKILL.md 报错；重名拒绝", async () => {
    const src = path.join(root, "_import_src", "my-imported");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(
      path.join(src, "SKILL.md"),
      "---\nname: my-imported\ndescription: 导入来的\n---\n\n# 正文\n",
      "utf8",
    );
    await fs.writeFile(path.join(src, "helper.py"), "print('hi')\n", "utf8");

    const name = await importAgentSkill("helper", { sourcePath: src });
    expect(name).toBe("my-imported");
    const dir = path.join(root, "helper", "skills", "my-imported");
    expect(await fs.stat(path.join(dir, "SKILL.md")).then((s) => s.isFile())).toBe(true);
    // 附带资源一起复制
    expect(await fs.stat(path.join(dir, "helper.py")).then((s) => s.isFile())).toBe(true);
    const skills = await listEffectiveSkills(path.join(root, "helper"));
    expect(skills.find((s) => s.name === "my-imported")?.source).toBe("agent");

    // 重名 → 拒绝
    await expect(importAgentSkill("helper", { sourcePath: src })).rejects.toThrow(/技能已存在/);

    // 不是技能目录 → 拒绝
    const notSkill = path.join(root, "_import_src", "plain");
    await fs.mkdir(notSkill, { recursive: true });
    await fs.writeFile(path.join(notSkill, "readme.txt"), "x", "utf8");
    await expect(importAgentSkill("helper", { sourcePath: notSkill })).rejects.toThrow(/SKILL.md/);
  });

  test("导入到共享池（所有 agent 继承）", async () => {
    const src = path.join(root, "_import_src", "shared-one");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(
      path.join(src, "SKILL.md"),
      "---\nname: shared-one\ndescription: 共享导入\n---\n\n正文\n",
      "utf8",
    );
    await importAgentSkill("helper", { sourcePath: src, target: "shared" });
    const skills = await listEffectiveSkills(path.join(root, "helper"));
    const hit = skills.find((s) => s.name === "shared-one");
    expect(hit?.source).toBe("shared");
  });
});

describe("上传技能文件夹", () => {
  test("还原目录树（含附带脚本）；重名 / 目录穿越 / 缺 SKILL.md 均拒绝", async () => {
    const enc = new TextEncoder();
    const files = [
      {
        path: "my-upload/SKILL.md",
        data: enc.encode("---\nname: my-upload\ndescription: up\n---\n\n# x"),
      },
      { path: "my-upload/scripts/run.py", data: enc.encode("print(1)\n") },
    ];
    const name = await uploadAgentSkill("helper", { files });
    expect(name).toBe("my-upload");
    const dir = path.join(root, "helper", "skills", "my-upload");
    expect(await fs.stat(path.join(dir, "SKILL.md")).then((s) => s.isFile())).toBe(true);
    expect(await fs.stat(path.join(dir, "scripts", "run.py")).then((s) => s.isFile())).toBe(true);

    // 重名 → 拒绝
    await expect(uploadAgentSkill("helper", { files })).rejects.toThrow(/已存在/);
    // 目录穿越 → 拒绝
    await expect(
      uploadAgentSkill("helper", {
        files: [{ path: "x/../evil.md", data: enc.encode("x") }],
      }),
    ).rejects.toThrow(/非法/);
    // 缺 SKILL.md → 拒绝
    await expect(
      uploadAgentSkill("helper", {
        files: [{ path: "y/readme.md", data: enc.encode("x") }],
      }),
    ).rejects.toThrow(/SKILL\.md/);
  });

  test("平铺上传（无顶层文件夹）时需显式指定 name", async () => {
    const enc = new TextEncoder();
    const name = await uploadAgentSkill("helper", {
      files: [{ path: "SKILL.md", data: enc.encode("---\nname: flat\n---\n正文") }],
      name: "flat-skill",
    });
    expect(name).toBe("flat-skill");
    expect(
      await fs
        .stat(path.join(root, "helper", "skills", "flat-skill", "SKILL.md"))
        .then((s) => s.isFile()),
    ).toBe(true);
  });
});

describe("渐进披露：只注入名称 + 用途", () => {
  test("withAgentSkills 追加 <agent_skills>，关闭的不注入", () => {
    const message = withAgentSkills(new SystemMessage("基础提示词"), [
      { name: "a", description: "技能 A", dir: "/x", source: "shared", disabled: false, overridesShared: false },
      { name: "b", description: "技能 B", dir: "/y", source: "agent", disabled: true, overridesShared: false },
    ]);
    expect(message.text).toContain("<agent_skills>");
    expect(message.text).toContain("- a: 技能 A");
    expect(message.text).not.toContain("技能 B"); // 关闭的不出现
  });

  test("没有可用技能时不追加块", () => {
    const base = new SystemMessage("基础提示词");
    const message = withAgentSkills(base, []);
    expect(message.text).toBe("基础提示词");
  });
});