import "dotenv/config";
import { randomBytes } from "node:crypto";
import prisma from "@rw/db";
import { hashPassword } from "@rw/auth/password";

// The sanctioned way to provision a Rockware-staff user (SUPPORT/ENGINEER).
// System users authenticate like normal users but hold NO workspace
// membership: their permissions resolve from SYSTEM_ROLE_PERMISSIONS in code,
// they are hidden from customer rosters, and no customer-facing API can
// create or escalate one.
//
// Usage:
//   pnpm exec tsx scripts/create-system-user.ts <email> <SUPPORT|ENGINEER> [password]
//
// Without a password argument, a random one is generated and printed once.

async function main() {
  const [email, roleArg, passwordArg] = process.argv.slice(2);
  if (!email || !roleArg) {
    console.error("Usage: tsx scripts/create-system-user.ts <email> <SUPPORT|ENGINEER> [password]");
    process.exit(1);
  }
  const systemRole = roleArg.toUpperCase();
  if (systemRole !== "SUPPORT" && systemRole !== "ENGINEER") {
    console.error(`Unknown system role "${roleArg}" — expected SUPPORT or ENGINEER`);
    process.exit(1);
  }
  const password = passwordArg ?? randomBytes(18).toString("base64url");
  if (password.length < 12) {
    console.error("Password must be at least 12 characters");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { systemRole, passwordHash, status: "ACTIVE" },
    create: { email: email.toLowerCase(), passwordHash, systemRole, status: "ACTIVE" },
    select: { id: true, email: true, systemRole: true },
  });

  console.log(`System user ready: ${user.email} (${user.systemRole}, ${user.id})`);
  if (!passwordArg) {
    console.log(`Generated password (shown once): ${password}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
