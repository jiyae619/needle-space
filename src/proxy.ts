import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

// /admin and /api/admin write to the catalog with the service-role key, and
// they ship in the same deployment as the public site. Being unlinked from the
// nav is not protection: anyone could POST to /api/admin/update-cafe.
//
// Set ADMIN_PASSWORD to enable them behind HTTP Basic auth. Set ADMIN_USERNAME
// too and the username must match; without it any username is accepted.
// Without ADMIN_PASSWORD they work only on `npm run dev`, and 404 everywhere else.

// Constant-time compare, so response timing doesn't leak how much matched.
function same(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function proxy(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  const username = process.env.ADMIN_USERNAME;
  if (!password) {
    return process.env.NODE_ENV === "development"
      ? NextResponse.next()
      : new NextResponse("Not found", { status: 404 });
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const passOk = same(decoded.slice(sep + 1), password);
    const userOk = !username || (sep !== -1 && same(decoded.slice(0, sep), username));
    if (passOk && userOk) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Needle Space admin"' },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
