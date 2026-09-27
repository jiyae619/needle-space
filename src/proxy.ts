import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

// /admin and /api/admin write to the catalog with the service-role key, and
// they ship in the same deployment as the public site. Being unlinked from the
// nav is not protection: anyone could POST to /api/admin/update-cafe.
//
// Set ADMIN_PASSWORD to enable them behind HTTP Basic auth (any username).
// Without it they work only on `npm run dev`, and 404 everywhere else.
export function proxy(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return process.env.NODE_ENV === "development"
      ? NextResponse.next()
      : new NextResponse("Not found", { status: 404 });
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
    const expected = Buffer.from(password);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return NextResponse.next();
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Needle Space admin"' },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
