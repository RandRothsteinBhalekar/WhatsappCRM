import { describe, it, expect, vi } from "vitest";
import { parseSelect, QueryBuilder } from "./query-builder";
import { CONVERSATION_SELECT } from "@/lib/inbox/conversations";
import type { Sql } from "./client";

/** Mirrors CONTACT_SELECT without importing the API module (i18n alias). */
const CONTACT_SELECT = "*, contact_tags(tags(*))";

describe("parseSelect", () => {
  it("parses CONVERSATION_SELECT with nested has-many + belongs-to", () => {
    const { root, embeds } = parseSelect(CONVERSATION_SELECT);
    expect(root).toEqual(["*"]);
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toMatchObject({
      alias: "contact",
      table: "contacts",
    });
    const nested = parseSelect(embeds[0].columns);
    expect(nested.root).toEqual(["*"]);
    expect(nested.embeds).toEqual([
      {
        alias: "contact_tags",
        table: "contact_tags",
        columns: "tags(*)",
      },
    ]);
    const tags = parseSelect(nested.embeds[0].columns);
    expect(tags.root).toEqual(["*"]);
    expect(tags.embeds).toEqual([
      { alias: "tags", table: "tags", columns: "*" },
    ]);
  });

  it("parses CONTACT_SELECT has-many embed", () => {
    const { root, embeds } = parseSelect(CONTACT_SELECT);
    expect(root).toEqual(["*"]);
    expect(embeds).toEqual([
      {
        alias: "contact_tags",
        table: "contact_tags",
        columns: "tags(*)",
      },
    ]);
  });

  it("keeps nested star out of root column names", () => {
    const { root, embeds } = parseSelect(
      "*, contact:contacts(*, contact_tags(tags(*)))",
    );
    expect(root.every((c) => c === "*" || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c))).toBe(
      true,
    );
    expect(embeds[0].columns).toContain("contact_tags");
    expect(root).not.toContain("contact_tags(tags(*))");
  });
});

describe("QueryBuilder embed hydration", () => {
  it("hydrates nested contact + contact_tags + tags without qIdent(*)", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM "conversations"')) {
        return [
          {
            id: "conv1",
            contact_id: "ct1",
            last_message_text: "hi",
          },
        ];
      }
      if (sql.includes('FROM "contacts"')) {
        return [{ id: "ct1", name: "Ada", phone: "+1" }];
      }
      if (sql.includes('FROM "contact_tags"')) {
        return [
          { id: "ctag1", contact_id: "ct1", tag_id: "t1" },
          { id: "ctag2", contact_id: "ct1", tag_id: "t2" },
        ];
      }
      if (sql.includes('FROM "tags"')) {
        return [
          { id: "t1", name: "VIP", color: "#f00" },
          { id: "t2", name: "Lead", color: "#0f0" },
        ];
      }
      return [];
    });

    const db = { unsafe } as unknown as Sql;
    const result = await new QueryBuilder(db, "conversations")
      .select(CONVERSATION_SELECT)
      .maybeSingle();

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      id: "conv1",
      contact: {
        id: "ct1",
        name: "Ada",
        contact_tags: [
          { tag_id: "t1", tags: { id: "t1", name: "VIP" } },
          { tag_id: "t2", tags: { id: "t2", name: "Lead" } },
        ],
      },
    });

    // Child selects must use bare * — never quote star as an identifier.
    for (const { sql } of calls) {
      expect(sql).not.toMatch(/"\*"/);
      if (sql.includes('FROM "contacts"') || sql.includes('FROM "contact_tags"') || sql.includes('FROM "tags"')) {
        expect(sql).toMatch(/^SELECT \*/);
      }
    }
  });

  it("hydrates CONTACT_SELECT contact_tags(tags(*))", async () => {
    const unsafe = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "contacts"') && !sql.includes("contact_tags")) {
        return [{ id: "ct1", name: "Ada" }];
      }
      if (sql.includes('FROM "contact_tags"')) {
        return [{ id: "ctag1", contact_id: "ct1", tag_id: "t1" }];
      }
      if (sql.includes('FROM "tags"')) {
        return [{ id: "t1", name: "VIP", color: "#f00" }];
      }
      return [];
    });

    const db = { unsafe } as unknown as Sql;
    const result = await new QueryBuilder(db, "contacts")
      .select(CONTACT_SELECT)
      .eq("id", "ct1")
      .maybeSingle();

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      id: "ct1",
      contact_tags: [{ tags: { id: "t1", name: "VIP" } }],
    });
  });
});
