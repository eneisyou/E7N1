# 单词表建表、迁移与 Markdown 数据导入指南

## 1. 目标

在 PostgreSQL 18+ 环境中，使用 Bun + TypeScript + EXPO + Hono + Drizzle ORM + drizzle-kit + pg + pgvector 完成：

1. 创建 lg 表；
2. 使用 uuidv7() 生成主键；
3. 创建 embedding 向量列和 HNSW 索引；
4. 将 Markdown 中的 18000 行数据导入数据库。

## 2. 安装依赖

```shell
bun add drizzle-orm pg
bun add -d drizzle-kit @types/pg
```

## 3. 环境变量

### Bun / Hono 后端

Bun 自带 `.env` 加载能力，不需要额外安装 `dotenv`。在项目根目录创建 `.env`：

```env
DATABASE_URL=postgres://user:password@localhost:5432/your_database
```

代码中直接使用 `process.env.DATABASE_URL` 即可读取。

### Expo 移动端

Expo 不直接使用 Bun 的 `.env` 机制，需要把变量写在 Expo 项目的 `.env` 文件中，并以 `EXPO_PUBLIC_` 开头：

```env
EXPO_PUBLIC_API_URL=https://your-backend.example.com
```

在 Expo 代码中通过 `process.env.EXPO_PUBLIC_API_URL` 读取。

后端数据库连接信息通常只放在 Bun / Hono 项目中，不需要暴露到 Expo 环境变量里。

## 4. Drizzle 配置

创建 drizzle.config.ts：

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

## 5. 定义单词表 Schema

创建 src/db/schema.ts：

```ts
import { pgTable, uuid, text, vector, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const lg = pgTable(
  "lg",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),

    wordJp: text("lg_jp").notNull(),
    lgCn: text("lg_cn").notNull(),
    wordEn: text("lg_en").notNull(),

    sentenceJp: text("eg_jp"),
    sentenceCn: text("eg_cn"),
    sentenceEn: text("eg_en"),

    embedding: vector("embedding", { dimensions: 768 }),
  },
  (table) => [
    index("idx_lg_embedding").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);
```

注意：

> uuidv7() 是 PostgreSQL 18 内置函数，不需要额外安装扩展。
> sql 需要从 drizzle-orm 导入。
> vector 和 HNSW 索引写法来自 Drizzle ORM 官方 pgvector 文档。
> 如果你的 drizzle-orm 版本暂不支持 vector，可以先用 text 存储向量字符串，后续再调整。

## 6. 手动创建 pgvector 扩展

Drizzle 不会自动创建 PostgreSQL 扩展，所以需要先手动执行一次：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

可以放在第一条自定义迁移里，也可以直接在数据库中执行。

## 7. 生成并应用迁移

```shell
bun drizzle-kit generate
bun drizzle-kit migrate
```

generate 会根据 schema.ts 生成迁移文件；migrate 会把迁移应用到数据库。

生成的迁移大致会包含：

```sql
CREATE TABLE lg (
id UUID PRIMARY KEY DEFAULT uuidv7(),
lg_cn TEXT NOT NULL,
lg_en TEXT NOT NULL,
lg_jp TEXT NOT NULL,
eg_jp TEXT NOT NULL,
eg_en TEXT NOT NULL,
eg_cn TEXT NOT NULL,
embedding vector(768)
);
```

其中768代表使用的嵌入模型的向量维度

```sql
CREATE INDEX idx_lg_embedding
ON lg USING hnsw (embedding vector_cosine_ops);
```

## 8. 准备 Markdown 数据

你的 Markdown 表有 7 列，不包含 id：

```markdown
| lg_cn | lg_en | lg_jp | eg_jp | eg_en | eg_cn | emb |
| ----- | ----- | ----- | ----- | ----- | ----- | --- |
```

建议先把 Markdown 表转成 CSV，列顺序保持为：

lg_cn,lg_en,lg_jp,eg_jp,eg_en,eg_cn,emb

emb 列需要是 pgvector 能识别的数组格式，例如：

```json
[0.01,-0.03,0.12,0.45,...]
```

如果 Markdown 里还没有 embedding，可以先只导入前 6 列，后续再补向量。

## 9. 批量导入脚本

创建 scripts/seed-lg.ts：

```ts
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { lg } from "../src/db/schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

const db = drizzle(pool);

function parseEmbedding(value: string | undefined): number[] | null {
  if (!value || value.trim() === "") return null;

  const trimmed = value.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return JSON.parse(trimmed);
  }

  return trimmed.split(",").map((v) => parseFloat(v.trim()));
}

async function main() {
  const file = Bun.argv[2];

  if (!file) {
    throw new Error(
      "请传入 CSV 文件路径，例如：bun scripts/seed-lg.ts data/lg.csv",
    );
  }

  const csv = readFileSync(file, "utf-8");

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;

  console.log(`准备导入 ${records.length} 行数据`);

  const batchSize = 500;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    const values = batch.map((row) => ({
      lgCn: row.lg_cn,
      lgEn: row.lg_en,
      lgJp: row.lg_jp,
      egJp: row.eg_jp || null,
      egEn: row.eg_en || null,
      egCn: row.eg_cn || null,
      emb: parseEmbedding(row.emb),
    }));

    await db.insert(lg).values(values).onConflictDoNothing();

    console.log(
      `已导入 ${Math.min(i + batchSize, records.length)} / ${records.length}`,
    );
  }

  await pool.end();
}

main();
```

运行：

```shell
bun scripts/seed-lg.ts data/lg.csv
```

如果 CSV 里还没有 embedding，可以把 emb 字段暂时设为 null。

## 10. 验证数据

```sql
SELECT COUNT(\*) FROM lg;

SELECT id, lg_cn, lg_jp, lg_en
FROM lg
LIMIT 10;
```

## 11. 后续语义查询示例

```sql
SELECT id, lg_cn, lg_jp, lg_en
FROM lg
ORDER BY embedding <=> $1::vector
LIMIT 30;
```

> 这里 $1 是查询向量
> <=> 是余弦距离运算符，和 vector_cosine_ops 索引匹配。

```

```

```

```
