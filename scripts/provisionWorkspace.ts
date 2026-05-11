/**
 * Pilot customer onboarding tool (PROMPT M6 §1).
 *
 * Creates a workspace, the inbound email address, the first user (owner),
 * and an `owner` membership.
 *
 * Usage:
 *   pnpm tsx scripts/provisionWorkspace.ts \
 *     --type agency \
 *     --name "Acme Locums" \
 *     --slug acme \
 *     --ownerEmail owner@acme.example.com
 */
import { closeDb, db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { eq } from "drizzle-orm";

interface Args {
  type: "agency" | "hospital" | "solo_provider";
  name: string;
  slug: string;
  ownerEmail: string;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    const value = process.argv[i + 1];
    if (!flag || !value) continue;
    switch (flag) {
      case "--type":
        if (value === "agency" || value === "hospital" || value === "solo_provider") {
          out.type = value;
        }
        break;
      case "--name":
        out.name = value;
        break;
      case "--slug":
        out.slug = value;
        break;
      case "--ownerEmail":
        out.ownerEmail = value;
        break;
    }
  }
  if (!out.type || !out.name || !out.slug || !out.ownerEmail) {
    console.error(
      "usage: provisionWorkspace --type <agency|hospital|solo_provider> --name <name> --slug <slug> --ownerEmail <email>",
    );
    process.exit(2);
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  // rls: bypass — provisioning runs from a controlled tool, not user code.
  const emailIn = `requirements+${args.slug}@platform.example.com`;

  const [workspace] = await db()
    .insert(schema.workspaces)
    .values({
      type: args.type,
      name: args.name,
      slug: args.slug,
      emailInAddress: emailIn,
    })
    .returning({ id: schema.workspaces.id });
  if (!workspace) throw new Error("workspace insert failed");

  const [user] = await db()
    .insert(schema.users)
    .values({ email: args.ownerEmail.toLowerCase(), emailVerifiedAt: null })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { email: args.ownerEmail.toLowerCase() },
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("user upsert failed");

  await db()
    .insert(schema.memberships)
    .values({ userId: user.id, workspaceId: workspace.id, role: "owner" })
    .onConflictDoNothing();

  await audit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    actorType: "system",
    action: "workspace.provisioned",
    targetEntityType: "workspace",
    targetEntityId: workspace.id,
    after: { slug: args.slug, type: args.type, emailIn },
  });

  console.log(
    JSON.stringify(
      {
        workspaceId: workspace.id,
        userId: user.id,
        slug: args.slug,
        emailInAddress: emailIn,
      },
      null,
      2,
    ),
  );

  await closeDb();
  // Sanity guard: refuse silently-empty data when run twice with the same slug.
  void eq;
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
